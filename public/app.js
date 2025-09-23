// app.js - minimal React app using socket.io
const e = React.createElement;

function App() {
    const [data, setData] = React.useState([]);
    const [connected, setConnected] = React.useState(false);
    const [serverStatus, setServerStatus] = React.useState({ lastSeen: null, online: false });
    const [config, setConfig] = React.useState({ altitude_m: 1350 });
    const [altitudeInput, setAltitudeInput] = React.useState('1350');
    // UI state for optional recent readings panel & menu
    const [showRecentPanel, setShowRecentPanel] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [recentCount, setRecentCount] = React.useState(25);
    const menuRef = React.useRef(null);
    const socketRef = React.useRef(null);
    const chartInstanceRef = React.useRef(null);
    const humInstanceRef = React.useRef(null);
    const presInstanceRef = React.useRef(null);
    const mqInstanceRef = React.useRef(null);
    const modalRef = React.useRef(null);
    const modalCanvasRef = React.useRef(null);
    const modalChartRef = React.useRef(null);

    React.useEffect(() => {
        const socket = io();
        socketRef.current = socket;
        socket.on('connect', () => setConnected(true));
        socket.on('disconnect', () => setConnected(false));
        socket.on('snapshot', (arr) => setData(arr || []));
        socket.on('device-status', (s) => setServerStatus(s || { lastSeen: null, online: false }));
        socket.on('config', (c) => { setConfig(c || { altitude_m: 1350 }); setAltitudeInput(String((c && c.altitude_m) || 1350)); });
        socket.on('new-data', (d) => {
            setData(prev => {
                const next = prev.concat([d]).slice(-200);
                return next;
            });
        });
        return () => socket.disconnect();
    }, []);

    // Close dropdown menu on outside click
    React.useEffect(() => {
        function handler(ev) {
            if (!menuRef.current) return;
            if (menuOpen && !menuRef.current.contains(ev.target)) {
                setMenuOpen(false);
            }
        }
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    // Initialize charts
    React.useEffect(() => {
        const ctx = document.getElementById('tempChart').getContext('2d');
        chartInstanceRef.current = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'BMP Temp (\u00b0C)',
                        data: [],
                        borderColor: 'rgba(255,99,132,1)',
                        backgroundColor: 'rgba(255,99,132,0.08)',
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.25
                    },
                    {
                        label: 'DHT Temp (\u00b0C)',
                        data: [],
                        borderColor: 'rgba(54,162,235,1)',
                        backgroundColor: 'rgba(54,162,235,0.06)',
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        borderWidth: 2,
                        fill: true,
                        tension: 0.25
                    }
                ]
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top', labels: { boxWidth: 20, padding: 16, usePointStyle: true } } },
                scales: { x: { display: false }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: 'rgba(15,23,32,0.65)' } } }
            }
        });

        const hctx = document.getElementById('humChart').getContext('2d');
        humInstanceRef.current = new Chart(hctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Humidity (%)', data: [], borderColor: 'rgba(75,192,192,1)', backgroundColor: 'rgba(75,192,192,0.06)', pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, fill: true, tension: 0.25 }] },
            options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 18, usePointStyle: true } } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: 'rgba(15,23,32,0.65)' } } } }
        });

        const pctx = document.getElementById('presChart').getContext('2d');
        presInstanceRef.current = new Chart(pctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Pressure (hPa)', data: [], borderColor: 'rgba(153,102,255,1)', backgroundColor: 'rgba(153,102,255,0.06)', pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, fill: true, tension: 0.25 }] },
            options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 18, usePointStyle: true } } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: 'rgba(15,23,32,0.65)' } } } }
        });

        const mctx = document.getElementById('mqChart').getContext('2d');
        mqInstanceRef.current = new Chart(mctx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'MQ Raw', data: [], borderColor: 'rgba(255,159,64,1)', backgroundColor: 'rgba(255,159,64,0.06)', pointRadius: 0, pointHoverRadius: 5, borderWidth: 2, fill: true, tension: 0.25 }] },
            options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 18, usePointStyle: true } } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: 'rgba(15,23,32,0.65)' } } } }
        });

        // attach click handlers to open fullscreen modal
        const attachOpen = (id, chartRef) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => openChartModal(chartRef));
        };
        attachOpen('tempChart', chartInstanceRef);
        attachOpen('humChart', humInstanceRef);
        attachOpen('presChart', presInstanceRef);
        attachOpen('mqChart', mqInstanceRef);

        return () => {
            chartInstanceRef.current && chartInstanceRef.current.destroy();
            humInstanceRef.current && humInstanceRef.current.destroy();
            presInstanceRef.current && presInstanceRef.current.destroy();
            mqInstanceRef.current && mqInstanceRef.current.destroy();
        };
    }, []);

    // Modal open/close helpers
    const openChartModal = (chartRef) => {
        try {
            const modal = document.getElementById('chartModal');
            const canvas = document.getElementById('modalChart');
            if (!modal || !canvas) return;
            // destroy previous modal chart
            if (modalChartRef.current) { modalChartRef.current.destroy(); modalChartRef.current = null; }
            // clone data & options
            const src = chartRef.current;
            if (!src) return;
            // open modal first so canvas gets layout
            modal.classList.add('open');
            // build a minimal config from the live chart's data/options
            const cfg = {
                type: src.config && src.config.type ? src.config.type : (src.type || 'line'),
                data: JSON.parse(JSON.stringify(src.data || src.config.data || {})),
                options: JSON.parse(JSON.stringify(src.options || src.config.options || {}))
            };
            // create chart instance
            modalChartRef.current = new Chart(canvas.getContext('2d'), cfg);
            // allow the browser a frame to resize the canvas, then update/resize the chart
            setTimeout(() => {
                try { modalChartRef.current.resize(); modalChartRef.current.update(); } catch (e) { /* ignore */ }
            }, 80);
            // handle ESC to close
            const escHandler = (ev) => { if (ev.key === 'Escape') closeChartModal(); };
            document.addEventListener('keydown', escHandler, { once: true });
        } catch (e) { console.error('Open modal failed', e); }
    };

    const closeChartModal = () => {
        const modal = document.getElementById('chartModal');
        if (!modal) return;
        modal.classList.remove('open');
        if (modalChartRef.current) { modalChartRef.current.destroy(); modalChartRef.current = null; }
    };

    // Update charts when data changes
    React.useEffect(() => {
        if (!chartInstanceRef.current) return;
        const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kathmandu' });
        const labels = data.map(d => {
            try { return fmt.format(new Date(d.receivedAt)); } catch (e) { const dt = new Date(d.receivedAt); const off = (5 * 60 + 45) * 60 * 1000; return new Date(dt.getTime() + off).toTimeString().split(' ')[0]; }
        });

        const bmpTemps = data.map(d => (d.bmp_temp !== undefined ? d.bmp_temp : null));
        const dhtTemps = data.map(d => (d.dht_temp !== undefined ? d.dht_temp : null));
        const hums = data.map(d => (d.dht_hum !== undefined ? d.dht_hum : null));
        const press = data.map(d => (d.bmp_pressure !== undefined ? d.bmp_pressure : null));
        const mqs = data.map(d => (d.mq_raw !== undefined ? d.mq_raw : null));

        chartInstanceRef.current.data.labels = labels;
        chartInstanceRef.current.data.datasets[0].data = bmpTemps;
        chartInstanceRef.current.data.datasets[1].data = dhtTemps;
        if (humInstanceRef.current) { humInstanceRef.current.data.labels = labels; humInstanceRef.current.data.datasets[0].data = hums; humInstanceRef.current.update('none'); }
        if (presInstanceRef.current) { presInstanceRef.current.data.labels = labels; presInstanceRef.current.data.datasets[0].data = press; presInstanceRef.current.update('none'); }
        if (mqInstanceRef.current) { mqInstanceRef.current.data.labels = labels; mqInstanceRef.current.data.datasets[0].data = mqs; mqInstanceRef.current.update('none'); }
        chartInstanceRef.current.update('none');
    }, [data]);

    const last = data.length ? data[data.length - 1] : null;

    // Device online: prefer server-side status, fallback to client heuristic
    const deviceOnline = serverStatus && serverStatus.lastSeen ? serverStatus.online : (() => {
        if (!data.length) return false;
        const last = data[data.length - 1];
        try { const delta = Date.now() - new Date(last.receivedAt).getTime(); return delta < 90000; } catch (e) { return false; }
    })();

    const lastSeenDisplay = (() => {
        const seen = serverStatus && serverStatus.lastSeen ? serverStatus.lastSeen : (data.length ? data[data.length - 1].receivedAt : null);
        if (!seen) return '\u2014';
        try { return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kathmandu' }).format(new Date(seen)); } catch (e) { const dt = new Date(seen); const off = (5 * 60 + 45) * 60 * 1000; return new Date(dt.getTime() + off).toISOString(); }
    })();

    // Helper to build CSV for download (ONLY the curated columns shown in dashboard, not raw full payload)
    const downloadCSV = () => {
        try {
            const slice = data.slice(-recentCount); // chronological oldest->newest
            if (!slice.length) return;
            const columns = [
                { key: 'receivedAt', label: 'Time (NST)' },
                { key: 'bmp_temp', label: 'BMP T (C)' },
                { key: 'dht_temp', label: 'DHT T (C)' },
                { key: 'dht_hum', label: 'Humidity (%)' },
                { key: 'bmp_pressure', label: 'Pressure (hPa)' },
                { key: 'bmp_sealevel', label: 'SL Pressure (hPa)' },
                { key: 'mq_raw', label: 'MQ Raw' },
                { key: 'mq_health', label: 'MQ Health' },
                { key: 'isDaytime', label: 'Daytime' },
                { key: 'comfortOverall', label: 'Comfort' },
                { key: 'environment', label: 'Env' }
            ];
            const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kathmandu' });
            const num = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '' : Number(v).toFixed(d);
            const lines = [columns.map(c => '"' + c.label + '"').join(',')];
            slice.forEach(r => {
                const rowObj = {
                    receivedAt: (() => { try { return timeFmt.format(new Date(r.receivedAt)); } catch (e) { return r.receivedAt || ''; } })(),
                    bmp_temp: num(r.bmp_temp),
                    dht_temp: num(r.dht_temp),
                    dht_hum: num(r.dht_hum),
                    bmp_pressure: num(r.bmp_pressure),
                    bmp_sealevel: num(r.bmp_sealevel),
                    mq_raw: (r.mq_raw !== undefined && r.mq_raw !== null) ? r.mq_raw : '',
                    mq_health: r.mq_health || '',
                    isDaytime: (r.isDaytime === true || r.isDaytime === false) ? (r.isDaytime ? 'Day' : 'Night') : '',
                    comfortOverall: (r.comfort && r.comfort.overall) ? r.comfort.overall : (r.comfort_status || ''),
                    environment: r.environment || ''
                };
                const line = columns.map(c => JSON.stringify(rowObj[c.key] !== undefined ? rowObj[c.key] : '')).join(',');
                lines.push(line);
            });
            const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `dashboard_readings_${slice.length}.csv`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 120);
        } catch (e) { console.error('CSV export failed', e); }
    };

    const recentSlice = React.useMemo(() => data.slice(-recentCount).reverse(), [data, recentCount]);

    const recentTable = () => {
        if (!recentSlice.length) return e('div', { className: 'empty' }, 'No data yet');
        // Curated columns (ordered)
        const columns = [
            { key: 'receivedAt', label: 'Time (NST)' },
            { key: 'bmp_temp', label: 'BMP T (°C)' },
            { key: 'dht_temp', label: 'DHT T (°C)' },
            { key: 'dht_hum', label: 'Humidity (%)' },
            { key: 'bmp_pressure', label: 'Pressure (hPa)' },
            { key: 'bmp_sealevel', label: 'SL Press (hPa)' },
            { key: 'mq_raw', label: 'MQ Raw' },
            { key: 'mq_health', label: 'MQ Health' },
            { key: 'isDaytime', label: 'Daytime' },
            { key: 'comfortOverall', label: 'Comfort' },
            { key: 'environment', label: 'Env' }
        ];
        const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kathmandu' });
        const num = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(d);
        // Build formatted rows
        const rows = recentSlice.map(r => ({
            receivedAt: (() => { try { return timeFmt.format(new Date(r.receivedAt)); } catch (e) { return r.receivedAt; } })(),
            bmp_temp: num(r.bmp_temp),
            dht_temp: num(r.dht_temp),
            dht_hum: num(r.dht_hum),
            bmp_pressure: num(r.bmp_pressure),
            bmp_sealevel: num(r.bmp_sealevel),
            mq_raw: (r.mq_raw !== undefined && r.mq_raw !== null) ? r.mq_raw : '—',
            mq_health: r.mq_health || '—',
            isDaytime: (r.isDaytime === true || r.isDaytime === false) ? (r.isDaytime ? 'Day' : 'Night') : '—',
            comfortOverall: (r.comfort && r.comfort.overall) ? r.comfort.overall : (r.comfort_status || '—'),
            environment: r.environment || '—'
        }));
        return e('div', { className: 'recent-table-wrapper' },
            e('table', { className: 'recent-table' },
                e('thead', null, e('tr', null, columns.map(c => e('th', { key: c.key }, c.label)))),
                e('tbody', null, rows.map((row, i) => e('tr', { key: i }, columns.map(c => e('td', { key: c.key }, row[c.key])))))
            )
        );
    };

    return e('div', { className: 'container' },
        // Modal for fullscreen charts
        e('div', { id: 'chartModal', className: 'chart-modal', onClick: (ev) => { if (ev.target.id === 'chartModal') closeChartModal(); } },
            e('div', { className: 'modal-card' },
                e('div', { className: 'modal-header' }, e('div', null, e('strong', null, 'Fullscreen Chart')), e('button', { className: 'close-btn', onClick: closeChartModal }, 'Close')),
                e('div', { className: 'modal-body' }, e('canvas', { id: 'modalChart' }))
            )
        ),
        e('header', { className: 'header' },
            e('h2', { className: 'title' }, 'Indoor Climate Monitoring System'),
            e('div', { className: 'header-actions' },
                e('div', { className: 'badges' },
                    e('span', { className: 'badge' + (connected ? ' badge-online' : ' badge-offline') }, connected ? 'Realtime' : 'No Realtime'),
                    e('span', { className: 'badge' + (deviceOnline ? ' badge-online' : ' badge-offline') }, deviceOnline ? 'Device Online' : 'Device Offline')
                ),
                e('div', { className: 'menu-root' },
                    e('button', { className: 'btn menu-btn pill', onClick: () => setMenuOpen(true) }, 'Menu')
                )
            )
        ),

        // Slide-in menu panel
        menuOpen && e('div', { className: 'menu-overlay', onClick: (ev) => { if (ev.target.classList.contains('menu-overlay')) setMenuOpen(false); } },
            e('aside', { className: 'menu-panel', ref: menuRef },
                e('div', { className: 'menu-panel-header' },
                    e('h3', null, 'Menu'),
                    e('button', { className: 'btn close-btn subtle small', onClick: () => setMenuOpen(false) }, '×')
                ),
                e('div', { className: 'menu-panel-body' },
                    e('div', { className: 'panel-actions' },
                        e('button', { className: 'btn action-btn primary', onClick: () => { setShowRecentPanel(true); setMenuOpen(false); } }, 'Show Recent Data'),
                        e('button', { className: 'btn action-btn', onClick: () => { downloadCSV(); setMenuOpen(false); } }, 'Download CSV')
                    ),
                    e('div', { className: 'panel-section' },
                        e('h4', null, 'Altitude / Pressure Calibration'),
                        e('div', { className: 'altitude-row' },
                            e('label', { htmlFor: 'altitude' }, 'Altitude (m)'),
                            e('input', { id: 'altitude', type: 'number', value: altitudeInput, onChange: ev => setAltitudeInput(ev.target.value) })
                        ),
                        e('div', { className: 'altitude-buttons' },
                            e('button', {
                                className: 'btn small-btn small',
                                onClick: async () => {
                                    const v = Number(altitudeInput);
                                    if (Number.isFinite(v)) {
                                        try {
                                            const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ altitude_m: v }) });
                                            const json = await res.json();
                                            setConfig(json);
                                        } catch (e) { console.error('Failed to save config', e); }
                                    }
                                }
                            }, 'Save'),
                            e('button', {
                                className: 'btn small-btn subtle small',
                                onClick: async () => {
                                    try {
                                        const res = await fetch('/api/push', { method: 'POST' });
                                        const json = await res.json();
                                        console.log('Push result', json);
                                    } catch (e) { console.error('Push failed', e); }
                                },
                                title: 'Broadcast current config to devices'
                            }, 'Push')
                        ),
                        e('div', { className: 'altitude-current' }, `Current: ${config.altitude_m} m`)
                    )
                )
            )
        ),


        // Hero section with data readings and comfort side-by-side
        e('section', { className: 'hero' },
            e('div', { className: 'hero-metrics card' },
                e('h3', { className: 'section-title' }, 'Live Readings'),
                e('div', { className: 'values' },
                    e('div', { className: 'value temp' }, e('div', { className: 'icon' }, '🌡️'), e('strong', null, 'BMP Temperature'), e('div', null, last && last.bmp_temp !== undefined ? `${last.bmp_temp.toFixed(1)} °C` : '—')),
                    e('div', { className: 'value temp' }, e('div', { className: 'icon' }, '🌡'), e('strong', null, 'DHT Temperature'), e('div', null, last && last.dht_temp !== undefined ? `${last.dht_temp.toFixed(1)} °C` : '—')),
                    e('div', { className: 'value hum' }, e('div', { className: 'icon' }, '💧'), e('strong', null, 'Humidity'), e('div', null, last && last.dht_hum ? `${last.dht_hum.toFixed(1)} %` : '—')),
                    e('div', { className: 'value pres' }, e('div', { className: 'icon' }, '🧭'), e('strong', null, 'Pressure'), e('div', null, last && last.bmp_pressure ? `${last.bmp_pressure.toFixed(1)} hPa` : '—')),
                    e('div', { className: 'value slpres' }, e('div', { className: 'icon' }, '⬆️'), e('strong', null, 'SL Pressure'), e('div', null, last && last.bmp_sealevel ? `${last.bmp_sealevel.toFixed(1)} hPa` : '—')),
                    e('div', { className: 'value mq' + (last && last.mq_health ? (last.mq_health.toLowerCase().includes('poor') ? ' mq-poor' : (last.mq_health.toLowerCase().includes('moderate') ? ' mq-moderate' : (last.mq_health.toLowerCase().includes('good') ? ' mq-good' : ''))) : '') },
                        e('div', { className: 'icon' }, '🫧'),
                        e('strong', null, 'MQ Raw'),
                        e('div', null, last ? `${last.mq_raw}` : '—'),
                        e('div', { style: { marginTop: 6 } }, last && last.mq_health ? e('span', { className: 'air-pill' }, last.mq_health) : null),
                        e('div', { style: { marginTop: 6, fontSize: 12, color: '#475569' } }, last && last.mq_health ? `Air: ${last.mq_health}` : ''),
                        e('div', { style: { marginTop: 4, fontSize: 11, color: '#64748b' } }, last && (typeof last.mq_baseline !== 'undefined') ? `Baseline: ${last.mq_baseline}` : '')
                    )
                )
            ),
            e('div', { className: 'hero-comfort card' },
                e('h3', { className: 'section-title' }, 'Comfort'),
                (() => {
                    if (!last || !last.comfort) return e('div', null, '—');
                    const c = last.comfort;
                    const cls = (s) => {
                        if (!s) return 'unknown';
                        return s.toLowerCase()
                            .replace(/high humidity risk/g, 'high-humidity-risk')
                            .replace(/slightly warm/g, 'slightly-warm')
                            .replace(/needs attention/g, 'needs-attention')
                            .replace(/ /g, '-');
                    };
                    return e('div', null,
                        e('div', { className: 'comfort-grid' },
                            e('div', { className: 'comfort-pill ' + cls(c.temperature) }, e('span', null, 'Temperature'), e('span', null, c.temperature || 'Unknown')),
                            e('div', { className: 'comfort-pill ' + cls(c.humidity) }, e('span', null, 'Humidity'), e('span', null, c.humidity || 'Unknown')),
                            e('div', { className: 'comfort-pill ' + cls(c.air_quality) }, e('span', null, 'Air Quality'), e('span', null, c.air_quality || 'Unknown')),
                            e('div', { className: 'comfort-pill ' + cls(c.overall) }, e('span', null, 'Overall Comfort'), e('span', null, c.overall || 'Unknown'))
                        ),
                        e('div', { style: { marginTop: 10, fontSize: 12, color: '#64748b' } }, `Environment: ${config.environment}`)
                    );
                })()
            )
        ),

        // Charts section
        e('div', { className: 'card charts-card' },
            e('div', { className: 'chart-main' }, e('canvas', { id: 'tempChart' })),
            e('div', { className: 'chart-grid' },
                e('div', { className: 'chart-card' }, e('canvas', { id: 'humChart' })),
                e('div', { className: 'chart-card' }, e('canvas', { id: 'presChart' })),
                e('div', { className: 'chart-card' }, e('canvas', { id: 'mqChart' }))
            )
        ),

        /* Legend / Explanation card */
        (() => {
            const tempRows = [
                ['Cold', '< 15', 'Too cold; discomfort, possible condensation risk changes'],
                ['Cool', '15 – <18 (and 18–<20 treated as Cool)', 'Slightly below ideal comfort'],
                ['Optimal', '20 – 26', 'Ideal indoor comfort band'],
                ['Slightly Warm', '>26 – 29', 'Minorly above optimal'],
                ['Warm', '>29 – 32', 'Noticeably warm – ventilation recommended'],
                ['Hot', '> 32', 'High heat stress potential']
            ];
            const humRows = [
                ['Dry', '< 30', 'Too dry; static & respiratory irritation risk'],
                ['Acceptable', '30 – <40 or >60 – 70', 'Usable but not ideal'],
                ['Optimal', '40 – 60', 'Ideal comfort & material preservation'],
                ['Humid', '>70 – 80', 'Too moist; mold growth potential rises'],
                ['High Humidity Risk', '> 80', 'High risk for mold & biological growth']
            ];
            const airRows = [
                ['Good', 'Near baseline', 'Clean / fresh baseline range'],
                ['Moderate', 'Small sustained rise', 'Some accumulation / ventilation useful'],
                ['Poor', 'Large deviation', 'Air quality degrading – ventilate soon'],
                ['Unhealthy', 'Critical sustained high', 'Strongly recommend immediate ventilation / source check']
            ];
            const overallRows = [
                ['Comfortable', 'Temp Optimal & Hum Optimal & Air Good', 'All ideal ranges'],
                ['Acceptable', 'Exactly 1 mild deviation', 'Slight drift – monitor'],
                ['Needs Attention', '≥2 deviations (non-critical)', 'Multiple factors off – adjust environment'],
                ['Unhealthy', 'Any critical (Hot / Cold / High Humidity Risk / Unhealthy Air)', 'Immediate mitigation recommended']
            ];
            const buildTable = (rows, prefix) => e('table', { className: 'legend-table' },
                e('thead', null, e('tr', null,
                    e('th', null, 'Category'),
                    e('th', null, prefix === 'air' ? 'Concept' : (prefix === 'overall' ? 'Rule' : 'Range / Rule')),
                    e('th', null, 'Meaning')
                )),
                e('tbody', null, rows.map(r => e('tr', { key: r[0] },
                    e('td', { className: 'cat ' + prefix + '-' + r[0].toLowerCase().replace(/ /g, '-') }, r[0]),
                    e('td', null, r[1]),
                    e('td', null, r[2])
                )))
            );
            return e('div', { className: 'card legend-card' },
                e('h3', { className: 'section-title' }, 'Legend'),
                e('p', { className: 'legend-intro' }, 'How readings map to comfort categories.'),
                e('div', { className: 'legend-section' }, e('h4', null, 'Temperature (°C)'), buildTable(tempRows, 'temp')),
                e('div', { className: 'legend-section' }, e('h4', null, 'Humidity (%)'), buildTable(humRows, 'hum')),
                e('div', { className: 'legend-section' }, e('h4', null, 'Air Quality (MQ Derived)'), buildTable(airRows, 'air')),
                e('div', { className: 'legend-section' }, e('h4', null, 'Overall Comfort'), buildTable(overallRows, 'overall')),
                e('p', { className: 'legend-footnote' }, 'Ranges are static; logic for overall comfort is computed server-side per incoming reading.')
            );
        })(),

        e('div', { style: { marginTop: 10, fontSize: 13, color: '#334155' } }, `Last seen: ${lastSeenDisplay}`),

        // Off-canvas recent data panel (optional)
        showRecentPanel && e('div', { className: 'recent-panel-overlay', onClick: (ev) => { if (ev.target.classList.contains('recent-panel-overlay')) setShowRecentPanel(false); } },
            e('div', { className: 'recent-panel' },
                e('div', { className: 'recent-panel-header' },
                    e('h3', null, 'Recent Readings'),
                    e('button', { className: 'btn close-btn subtle small', onClick: () => setShowRecentPanel(false) }, '×')
                ),
                e('div', { className: 'recent-panel-controls' },
                    e('label', null, 'Show'),
                    e('select', { value: recentCount, onChange: ev => setRecentCount(Number(ev.target.value)) }, [10, 25, 50, 100, 200].map(n => e('option', { key: n, value: n }, n))),
                    e('span', { style: { marginLeft: 4 } }, 'rows'),
                    e('button', { className: 'btn small-btn small', style: { marginLeft: 'auto' }, onClick: downloadCSV }, 'Export CSV')
                ),
                e('div', { className: 'recent-panel-body' }, recentTable()),
                e('div', { className: 'recent-json-toggle' },
                    e('details', null,
                        e('summary', null, 'Raw JSON (current selection)'),
                        e('pre', null, (() => {
                            const slice = recentSlice.map(r => ({ ...r }));
                            return JSON.stringify(slice, null, 2);
                        })())
                    )
                )
            )
        )
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
