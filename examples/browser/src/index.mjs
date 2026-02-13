import { Buffer } from "buffer/";
import MDBReader from "mdb-reader";
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { Grid } from 'ag-grid-community';

const button = document.getElementById("button");
const input = document.getElementById("input");
const status = document.getElementById("status");
const currentTableEl = document.getElementById("currentTable");
const tableInfo = document.getElementById("tableInfo");

const tablesGridDiv = document.getElementById('tablesGrid');
const rowsGridDiv = document.getElementById('rowsGrid');

let reader = null;
let tables = [];
let tableMap = new Map();

// AG Grid instances
let tablesGrid;
let rowsGrid;
let tablesGridOptions;
let rowsGridOptions;

// relationship cache (heuristic)
let relationships = [];

button.addEventListener("click", () => loadFile());
input.addEventListener('change', () => loadFile());

// support drag & drop of a file anywhere on the page
window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) {
        // set the input.files where possible for consistency
        try { input.files = e.dataTransfer.files; } catch (err) { /* readonly in some browsers */ }
        loadFile(f);
    }
});

function setStatus(text) {
    status.innerText = text;
}

// --- localStorage helpers: save/load file as base64 so refresh preserves state ---
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000; // 32KB chunks
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function saveFileToLocalStorage(base64, name) {
    try {
        localStorage.setItem('mdb-reader:lastFile', base64);
        localStorage.setItem('mdb-reader:lastFileName', name || '');
        setStatus('Saved to local storage');
    } catch (e) {
        console.warn('Could not save to localStorage', e);
        setStatus('Loaded (localStorage save failed)');
    }
}

async function tryLoadFromLocalStorage() {
    const base64 = localStorage.getItem('mdb-reader:lastFile');
    if (!base64) return;
    setStatus('Loading last file from local storage...');
    try {
        const ab = base64ToArrayBuffer(base64);
        const buf = Buffer.from(ab);
        reader = new MDBReader(buf);
        await buildTablesList();
        setStatus('Loaded from local storage');
    } catch (e) {
        console.error('Failed to load from localStorage', e);
        setStatus('Failed to load saved DB');
    }
}

async function loadFile(droppedFile) {
    setStatus('Loading file...');
    let file = droppedFile;
    if (!file) {
        const files = input.files;
        if (!files || files.length !== 1) return setStatus('Select one file');
        file = files[0];
    }

    const fr = new FileReader();
    fr.onload = async (e) => {
        try {
            const buf = Buffer.from(e.target.result);
            reader = new MDBReader(buf);
            // persist in localStorage so refresh keeps DB
            try {
                const base64 = arrayBufferToBase64(e.target.result);
                saveFileToLocalStorage(base64, file.name);
            } catch (err) {
                console.warn('localStorage save failed', err);
            }
            await buildTablesList();
            setStatus('Loaded');
        } catch (err) {
            console.error(err);
            setStatus('Error loading file: ' + err.message);
        }
    };
    fr.readAsArrayBuffer(file);
}

async function buildTablesList() {
    const names = reader.getTableNames();
    tables = await Promise.all(names.map(async (name) => {
        try {
            const t = reader.getTable(name);
            const rc = t.rowCount;
            tableMap.set(name, t);
            return { name, rowCount: rc };
        } catch (e) {
            return { name, rowCount: 0 };
        }
    }));

    // build a simple relationships cache by attempting to read MSysRelationships if present
    try {
        const relTable = reader.getTable('MSysRelationships');
        const rels = relTable.getData({rowLimit: 10000});
        // store raw rel rows for hover/click heuristics
        relationships = rels;
    } catch (e) {
        relationships = [];
    }

    renderTablesGrid();
}

function renderTablesGrid() {
    const columnDefs = [
        { field: 'name', headerName: 'Table', sortable: true, filter: true, flex: 1 },
        { field: 'rowCount', headerName: 'Rows', sortable: true, filter: 'agNumberColumnFilter', width: 110 }
    ];

        tablesGridOptions = {
            columnDefs,
            rowData: tables,
            rowSelection: 'single',
                onRowClicked: (e) => {
                    selectTable(e.data.name);
                },
                onSelectionChanged: (e) => {
                    const sel = e.api.getSelectedRows();
                    if (sel && sel[0]) selectTable(sel[0].name);
                },
            onFirstDataRendered: (params) => params.api.sizeColumnsToFit(),
            defaultColDef: { resizable: true },
        };

        if (tablesGrid) {
            // options.api should be available after initial grid creation
            if (tablesGridOptions && tablesGridOptions.api) {
                tablesGridOptions.api.setRowData(tables);
                // auto-size table list columns to fit content
                try {
                // auto-size but skip header width to ignore label size
                tablesGridOptions.columnApi && tablesGridOptions.columnApi.autoSizeColumns(['name','rowCount'], true);
            } catch (e) {}
            }
            return;
        }
        tablesGrid = new Grid(tablesGridDiv, tablesGridOptions);
        setTimeout(() => {
            try {
                tablesGridOptions.columnApi && tablesGridOptions.columnApi.autoSizeColumns(['name','rowCount'], true);
            } catch (e) {}
        }, 50);
}

function selectTable(name) {
    const tbl = tableMap.get(name);
    if (!tbl) return;
    currentTableEl.innerText = name;
    tableInfo.innerText = `${tbl.columnCount} columns • ${tbl.rowCount} rows`;

    // load first N rows for display (limit to avoid freezing large DBs)
    const rows = tbl.getData({ rowLimit: 5000 });

    renderRowsGrid(name, tbl.getColumnNames(), rows);

    // highlight selection in tables grid
    highlightTableInList(name);
}

function renderRowsGrid(tableName, columnNames, rows) {
    // Build column definitions where width is computed from cell content only (ignore header label width)
    // For performance we sample rows when dataset is large.
    function measureTextWidth(text, font) {
        const ctx = document._agMeasureCtx || (document._agMeasureCtx = document.createElement('canvas').getContext('2d'));
        ctx.font = font || getComputedStyle(rowsGridDiv).font || '13px system-ui';
        return Math.ceil(ctx.measureText(String(text)).width);
    }

    // Determine font used in grid cells (approx)
    const gridFont = (() => {
        const cs = getComputedStyle(rowsGridDiv);
        const fontSize = cs.fontSize || '13px';
        const fontFamily = cs.fontFamily || '-apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif';
        return `${fontSize} ${fontFamily}`;
    })();

    // sample rows up to a limit for measurement
    const SAMPLE_LIMIT = 1000;
    let sampleRows = rows || [];
    if (sampleRows.length > SAMPLE_LIMIT) {
        // evenly sample SAMPLE_LIMIT rows across the dataset
        const step = Math.max(1, Math.floor(sampleRows.length / SAMPLE_LIMIT));
        const sampled = [];
        for (let i = 0; i < sampleRows.length; i += step) sampled.push(sampleRows[i]);
        sampleRows = sampled.slice(0, SAMPLE_LIMIT);
    }

    const columnDefs = columnNames.map(c => {
        // detect numeric-only columns (based on loaded rows)
        const isNumeric = rows && rows.length > 0 && rows.every(r => r[c] === null || typeof r[c] === 'number');

        // compute max width of the cell content sample for this column
        let maxWidth = 24; // minimal width
        for (let i = 0; i < sampleRows.length; ++i) {
            const v = sampleRows[i][c];
            if (v === null || v === undefined) continue;
            const str = (typeof v === 'object') ? JSON.stringify(v) : String(v);
            const w = measureTextWidth(str, gridFont);
            if (w > maxWidth) maxWidth = w;
        }

        // add padding for cell padding and sort icon
        const padding = 28;
        const width = Math.min(Math.max(maxWidth + padding, 40), 2000);

        const def = { field: c, headerName: c, sortable: true, filter: true, width, cellRenderer: cellRendererFactory(tableName, c) };
        if (isNumeric) {
            def.cellClass = 'ag-right-aligned-cell';
        }
        return def;
    });

        rowsGridOptions = {
            columnDefs,
            rowData: rows,
        rowSelection: 'single',
            onCellClicked: async (params) => {
                // follow clicked value to other tables (heuristic): search for exact value in other tables
                const value = params.value;
                if (value === null || value === undefined) return;
                await followValue(tableName, params.colDef.field, value);
            },
            onCellMouseOver: (params) => {
                // highlight tables that contain this value (hover)
                const value = params.value;
                if (value === null || value === undefined) return;
                highlightTablesReferencingValue(value, tableName, params.colDef.field);
            },
            onFirstDataRendered: (params) => {
                // auto-size columns to their content so rotated headers save space
                try {
                    const colIds = columnDefs.map(cd => cd.field);
                    if (rowsGridOptions && rowsGridOptions.columnApi) {
                        // pass `skipHeader=true` so header label width is ignored
                        rowsGridOptions.columnApi.autoSizeColumns(colIds, true);
                    } else if (params && params.columnApi) {
                        params.columnApi.autoSizeColumns(colIds, true);
                    }
                } catch (e) {
                    // ignore
                }
            },
            defaultColDef: { resizable: true },
            headerHeight: 72
        };

            if (rowsGrid) {
                if (rowsGridOptions && rowsGridOptions.api) {
                    rowsGridOptions.api.setColumnDefs(columnDefs);
                    rowsGridOptions.api.setRowData(rows);
                    // auto-size again after update
                    setTimeout(() => {
                        try {
                            const colIds = columnDefs.map(cd => cd.field);
                              rowsGridOptions.columnApi && rowsGridOptions.columnApi.autoSizeColumns(colIds, true);
                        } catch (e) {}
                    }, 50);
                }
                return;
            }
            rowsGrid = new Grid(rowsGridDiv, rowsGridOptions);
            // after creation, auto-size columns once the grid API is available
            setTimeout(() => {
                try {
                    const colIds = columnDefs.map(cd => cd.field);
                    rowsGridOptions.columnApi && rowsGridOptions.columnApi.autoSizeColumns(colIds, true);
                } catch (e) {}
            }, 50);
}

function cellRendererFactory(tableName, columnName) {
    return function(params) {
        const v = params.value;
        if (v === null || v === undefined) return '';
        // Render primitives and small objects; show clickable style
        const text = (typeof v === 'object') ? JSON.stringify(v) : String(v);
        return `<span style="color:#0b64c6;cursor:pointer;text-decoration:underline;">${escapeHtml(text)}</span>`;
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}

function highlightTableInList(name) {
    if (!tablesGridOptions || !tablesGridOptions.api) return;
    tablesGridOptions.api.forEachNode(node => node.setSelected(node.data.name === name));
}

async function followValue(originTable, originCol, value) {
    setStatus('Searching referenced tables...');
    // search each other table for an exact match in any column (limit rows scanned)
    for (const t of tables) {
        if (t.name === originTable) continue;
        try {
            const tbl = tableMap.get(t.name);
            // scan up to 10000 rows to avoid freeze
            const data = tbl.getData({ rowLimit: 10000 });
            for (let i = 0; i < data.length; ++i) {
                const row = data[i];
                for (const col of Object.keys(row)) {
                    if (row[col] === value) {
                        // found a referential match -- navigate
                        selectTable(t.name);
                        // after rendering, try to select the matching row in the rows grid
                        setTimeout(() => {
                            if (!rowsGrid) return;
                            rowsGrid.api.forEachNode(node => node.setSelected(Object.values(node.data).some(v => v === value)));
                            setStatus('Found match in ' + t.name);
                        }, 50);
                        return;
                    }
                }
            }
        } catch (e) {
            // ignore
        }
    }
    setStatus('No matching value found in other tables');
}

function highlightTablesReferencingValue(value, originTable, originCol) {
    // simple heuristic: mark tables that contain the hovered value in their first N rows
    if (!tablesGridOptions || !tablesGridOptions.api) return;
    tablesGridOptions.api.forEachNode(node => node.setRowClass(''));
    tablesGridOptions.api.forEachNode(node => {
        if (node.data.name === originTable) return;
        try {
            const tbl = tableMap.get(node.data.name);
            const data = tbl.getData({ rowLimit: 200 });
            const found = data.some(r => Object.values(r).some(v => v === value));
            if (found) {
                // add a CSS class to highlight
                node.setRowClass('referenced-table');
            }
        } catch (e) { }
    });
}

// Add CSS for highlight rows (tables grid) via a style node
const style = document.createElement('style');
style.innerHTML = `
.ag-row.referenced-table { background-color: rgba(255,230,130,0.4) !important; }
`;
document.head.appendChild(style);

// Attempt to restore previous file from localStorage on load
tryLoadFromLocalStorage();

