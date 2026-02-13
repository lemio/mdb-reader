import { Buffer } from "buffer/";
import MDBReader from "mdb-reader";

import { createGrid, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-theme-quartz.css';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

// Wrap all DOM-dependent initialisation in DOMContentLoaded so the script can live in <head>
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const status = document.getElementById('status');

    const leftGridDiv = document.getElementById('leftGrid');
    const rightGridDiv = document.getElementById('rightGrid');

    let reader = null;
    let tableMap = new Map();

    const leftGridOptions = {
        columnDefs: [
            { field: 'name', headerName: 'Table', sortable: true, filter: true, flex: 1 },
            { field: 'rowCount', headerName: 'Rows', sortable: true, filter: 'agNumberColumnFilter', width: 120 }
        ],
        rowData: [],
        rowSelection: { mode: 'singleRow', enableClickSelection: true, checkboxes: false },
        onRowClicked: (e) => {
            if (e && e.data) {
                showTable(e.data.name);
            }
        }
    };

    const rightGridOptions = {
        columnDefs: [],
        rowData: [],
        defaultColDef: { sortable: true, filter: true, resizable: true, floatingFilter: true },
        animateRows: true
    };

    const leftGridApi = createGrid(leftGridDiv, leftGridOptions);
    const rightGridApi = createGrid(rightGridDiv, rightGridOptions);

    // Divider drag-to-resize logic
    const divider = document.getElementById('divider');
    const leftPanel = document.getElementById('left');
    const rightPanel = document.getElementById('right');
    let isDragging = false;
    const minLeft = 160;
    const maxLeft = 900;

    divider.addEventListener('mousedown', (e) => {
        isDragging = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        // compute new left width relative to container
        const containerRect = document.getElementById('container').getBoundingClientRect();
        let newLeft = e.clientX - containerRect.left;
        if (newLeft < minLeft) newLeft = minLeft;
        if (newLeft > maxLeft) newLeft = maxLeft;
        leftPanel.style.flex = `0 0 ${newLeft}px`;
        leftPanel.style.width = `${newLeft}px`;
        // let AG Grid recalculate layout
        try { leftGridApi.sizeColumnsToFit(); } catch (e) { /* ignore */ }
        try { rightGridApi.doLayout(); } catch (e) { /* ignore */ }
    });

    window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    function setStatus(text) {
        status.innerText = text;
    }

    // Try to persist file to localStorage first (fast), but fall back to IndexedDB when quota is exceeded
    function isQuotaError(err) {
        if (!err) return false;
        return (
            err.name === 'QuotaExceededError' ||
            err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            err.code === 22 ||
            err.code === 1014
        );
    }

    async function idbOpen() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('mdb-reader', 1);
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbSaveFile(file, name) {
        const db = await idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readwrite');
            const store = tx.objectStore('files');
            const putReq = store.put({ file, name }, 'file');
            putReq.onsuccess = () => {
                db.close();
                resolve();
            };
            putReq.onerror = () => {
                db.close();
                reject(putReq.error);
            };
        });
    }

    async function idbLoadFile() {
        const db = await idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readonly');
            const store = tx.objectStore('files');
            const getReq = store.get('file');
            getReq.onsuccess = async () => {
                const entry = getReq.result;
                db.close();
                if (!entry) return resolve(null);
                try {
                    const ab = await entry.file.arrayBuffer();
                    resolve({ arrayBuffer: ab, name: entry.name });
                } catch (e) {
                    resolve(null);
                }
            };
            getReq.onerror = () => {
                db.close();
                reject(getReq.error);
            };
        });
    }

    async function idbDeleteFile() {
        const db = await idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', 'readwrite');
            const store = tx.objectStore('files');
            const del = store.delete('file');
            del.onsuccess = () => { db.close(); resolve(); };
            del.onerror = () => { db.close(); reject(del.error); };
        });
    }

    function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    async function saveFile(file) {
        // Try localStorage first (encode to base64)
        try {
            const base64 = await fileToBase64(file);
            try {
                localStorage.setItem('mdb-base64', base64);
                localStorage.setItem('mdb-name', file.name);
                return 'localStorage';
            } catch (err) {
                if (isQuotaError(err)) {
                    // fall back to IndexedDB
                    await idbSaveFile(file, file.name);
                    return 'indexedDB';
                }
                // other storage error: still try IndexedDB
                console.warn('localStorage save failed', err);
                await idbSaveFile(file, file.name);
                return 'indexedDB';
            }
        } catch (err) {
            // fileToBase64 failed or other problem - try IndexedDB storing the Blob directly
            try {
                await idbSaveFile(file, file.name);
                return 'indexedDB';
            } catch (e) {
                console.warn('IndexedDB save failed', e);
                throw e;
            }
        }
    }

    async function loadStoredFile() {
        const base64 = localStorage.getItem('mdb-base64');
        const name = localStorage.getItem('mdb-name');
        if (base64) {
            return { arrayBuffer: base64ToArrayBuffer(base64), name };
        }
        // try IndexedDB
        try {
            const entry = await idbLoadFile();
            return entry; // may be null or {arrayBuffer, name}
        } catch (e) {
            console.warn('IndexedDB load failed', e);
            return null;
        }
    }

    async function handleFile(file) {
        try {
            const fr = new FileReader();
            fr.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const buf = Buffer.from(arrayBuffer);
                    reader = new MDBReader(buf);

                    // persist the file: prefer localStorage, but fall back to IndexedDB when quota is hit
                    try {
                        const where = await saveFile(file);
                        console.log('File persisted to', where);
                    } catch (err) {
                        console.warn('Could not persist file', err);
                    }

                    await buildTablesList();
                    setStatus(file.name);
                } catch (err) {
                    console.error(err);
                    setStatus('');
                }
            };
            fr.readAsArrayBuffer(file);
        } catch (err) {
            console.error(err);
            setStatus('');
        }
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(r.error);
            r.onload = () => {
                // r.result is a data: URL like data:application/octet-stream;base64,AAA
                const dataUrl = r.result;
                const idx = dataUrl.indexOf(',');
                resolve(dataUrl.slice(idx + 1));
            };
            r.readAsDataURL(file);
        });
    }

    async function buildTablesList() {
        try {
            const names = reader.getTableNames();
            const tables = await Promise.all(names.map(async (name) => {
                try {
                    const t = reader.getTable(name);
                    const rc = t.rowCount;
                    tableMap.set(name, t);
                    return { name, rowCount: rc };
                } catch (e) {
                    return { name, rowCount: 0 };
                }
            }));

            leftGridApi.setGridOption('rowData', tables);
            // auto-select first table if present
            if (tables.length > 0) {
                leftGridApi.forEachNode((node) => node.setSelected(node.rowIndex === 0));
                showTable(tables[0].name);
            } else {
                rightGridApi.setGridOption('columnDefs', []);
                rightGridApi.setGridOption('rowData', []);
            }
        } catch (err) {
            console.error('buildTablesList error', err);
            setStatus('');
        }
    }

    async function sampleRowsForTable(t, sampleSize = 1000) {
        const rc = t.rowCount;
        if (rc <= sampleSize) {
            // small table: return all rows
            return t.getData();
        }

        const blocks = 20; // number of blocks to fetch
        const blockSize = Math.ceil(sampleSize / blocks);
        const rows = [];
        for (let i = 0; i < blocks; i++) {
            if (rows.length >= sampleSize) break;
            const offset = Math.floor((i * rc) / blocks);
            try {
                const chunk = t.getData({ rowOffset: offset, rowLimit: blockSize });
                rows.push(...chunk);
            } catch (e) {
                // if a block fails, skip it
                console.warn('sample block failed', e);
            }
        }
        // Trim to sampleSize
        return rows.slice(0, sampleSize);
    }

    function computeColumnWidths(columnNames, sampleRows) {
        // Collect all lengths for each column to compute percentile
        const lengths = {};
        for (const name of columnNames) lengths[name] = [];
        
        for (const row of sampleRows) {
            for (const name of columnNames) {
                let v = row[name];
                if (v === undefined || v === null) v = '';
                const s = String(v);
                lengths[name].push(s.length);
            }
        }

        // Use 75th percentile (3/4 median) instead of max to avoid outliers
        const percentile75 = (arr) => {
            if (arr.length === 0) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const index = Math.floor(sorted.length * 0.75);
            return sorted[index];
        };

        // px per character estimate. Increase slightly to reduce clipping.
        const charWidth = 12; // px per character estimate
        const cellPadding = 24; // extra pixels to account for cell padding, sort icon, etc.
        const minWidth = 60;
        const maxWidth = 800;
        const widths = {};
        for (const name of columnNames) {
            const len75 = percentile75(lengths[name]);
            const w = Math.ceil(len75 * charWidth) + cellPadding;
            widths[name] = Math.min(Math.max(w, minWidth), maxWidth);
        }
        return widths;
    }

    function showTable(name) {
        const t = tableMap.get(name);
        if (!t) {
            rightGridApi.setGridOption('columnDefs', []);
            rightGridApi.setGridOption('rowData', []);
            return;
        }

        // get all data (beware large tables)
        const rows = t.getData();

        // derive column defs from column names if available
        let columnNames = [];
        try {
            columnNames = t.getColumnNames();
        } catch (e) {
            if (rows.length > 0) columnNames = Object.keys(rows[0]);
        }

        // compute widths based on sample (ignore header label length)
        (async () => {
            try {
                const sampleRows = await sampleRowsForTable(t, 1000);
                const widths = computeColumnWidths(columnNames, sampleRows);
                const cols = columnNames.map((c) => ({ field: c, headerName: c, sortable: true, filter: true, resizable: true, width: widths[c] || 100 }));
                rightGridApi.setGridOption('columnDefs', cols);
                rightGridApi.setGridOption('rowData', rows);
                
                // If columns don't fill the width, expand them proportionally
                setTimeout(() => {
                    try {
                        const gridWidth = rightGridDiv.clientWidth;
                        const totalColWidth = Object.values(widths).reduce((sum, w) => sum + w, 0);
                        if (totalColWidth < gridWidth - 50) { // -50 for scrollbar
                            rightGridApi.sizeColumnsToFit();
                        }
                    } catch (e) { /* ignore */ }
                }, 100);
            } catch (err) {
                console.warn('Could not compute column widths, falling back', err);
                const cols = columnNames.map((c) => ({ field: c, headerName: c, sortable: true, filter: true, resizable: true }));
                rightGridApi.setGridOption('columnDefs', cols);
                rightGridApi.setGridOption('rowData', rows);
                setTimeout(() => {
                    try { rightGridApi.sizeColumnsToFit(); } catch (e) { /* ignore */ }
                }, 100);
            }
        })();

        // highlight selected row in left grid
        leftGridApi.forEachNode((node) => node.setSelected(node.data && node.data.name === name));
    }

    // wire file input change and upload button
    uploadBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        handleFile(files[0]);
    });

    // drag & drop anywhere
    function isAllowedFileName(name) {
        if (!name) return false;
        const n = name.toLowerCase();
        return n.endsWith('.mdb') || n.endsWith('.accdb');
    }

    window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });

    window.addEventListener('dragenter', (e) => {
        try {
            if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                const item = e.dataTransfer.items[0];
                let file = null;
                try { file = item.getAsFile(); } catch (err) { /* ignore */ }
                if (file && !isAllowedFileName(file.name)) {
                    document.querySelector('.toolbar').classList.add('drag-invalid');
                } else {
                    document.querySelector('.toolbar').classList.remove('drag-invalid');
                    document.querySelector('.toolbar').classList.add('drag-valid');
                }
            }
        } catch (err) {
            // ignore
        }
        e.preventDefault();
    });

    window.addEventListener('dragleave', (e) => {
        const pc = document.querySelector('.toolbar');
        if (pc) { pc.classList.remove('drag-invalid'); pc.classList.remove('drag-valid'); }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        const pc = document.querySelector('.toolbar');
        if (pc) { pc.classList.remove('drag-invalid'); pc.classList.remove('drag-valid'); }
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const f = e.dataTransfer.files[0];
            if (!isAllowedFileName(f.name)) {
                // briefly show invalid state
                if (pc) pc.classList.add('drag-invalid');
                setTimeout(() => { if (pc) pc.classList.remove('drag-invalid'); }, 1200);
                return;
            }
            handleFile(f);
        }
    });

    // attempt to load from localStorage on startup
    (async function initFromStorage() {
        try {
            const entry = await loadStoredFile();
            if (!entry || !entry.arrayBuffer) {
                // no stored DB
                setStatus('');
                return;
            }
            const buf = Buffer.from(entry.arrayBuffer);
            reader = new MDBReader(buf);
            await buildTablesList();
            // show filename only
            setStatus(entry.name || '');
        } catch (err) {
            console.error('Could not restore DB from storage', err);
            setStatus('');
        }
    })();

});

