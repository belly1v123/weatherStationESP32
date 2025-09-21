// app.js - minimal React app using socket.io
const e = React.createElement;

function App() {
    const [data, setData] = React.useState([]);
    const [connected, setConnected] = React.useState(false);
    const [serverStatus, setServerStatus] = React.useState({ lastSeen: null, online: false });
    const [config, setConfig] = React.useState({ altitude_m: 1350 });
    const [altitudeInput, setAltitudeInput] = React.useState('1350');
    const socketRef = React.useRef(null);
    const chartInstanceRef = React.useRef(null);
    const humInstanceRef = React.useRef(null);
    const presInstanceRef = React.useRef(null);
    const mqInstanceRef = React.useRef(null);

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

        return () => {
            chartInstanceRef.current && chartInstanceRef.current.destroy();
            humInstanceRef.current && humInstanceRef.current.destroy();
            presInstanceRef.current && presInstanceRef.current.destroy();
            mqInstanceRef.current && mqInstanceRef.current.destroy();
        };
    }, []);

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

    return e('div', { className: 'container' },
        e('header', { className: 'header' },
            e('h2', { className: 'title' }, 'ESP32 Weather Dashboard'),
            e('div', { className: 'badges' },
                e('span', { className: 'badge' + (connected ? ' badge-online' : ' badge-offline') }, connected ? 'Realtime' : 'No Realtime'),
                ' ',
                e('span', { className: 'badge' + (deviceOnline ? ' badge-online' : ' badge-offline') }, deviceOnline ? 'Device Online' : 'Device Offline')
            )
        ),

        // Altitude config UI
        e('div', { className: 'card' },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                e('label', { htmlFor: 'altitude', style: { minWidth: 90 } }, 'Altitude (m):'),
                e('input', { id: 'altitude', type: 'number', value: altitudeInput, onChange: (ev) => setAltitudeInput(ev.target.value), style: { width: 120 } }),
                e('button', {
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
                }, 'Save')
                ,
                e('button', {
                    onClick: async () => {
                        try {
                            // Hit server push endpoint which will broadcast config to clients
                            const res = await fetch('/api/push', { method: 'POST' });
                            const json = await res.json();
                            console.log('Push result', json);
                        } catch (e) { console.error('Push failed', e); }
                    },
                    title: 'Request server to broadcast current config to connected devices immediately'
                }, 'Push now')
            ),
            e('div', { style: { marginTop: 8, color: '#475569' } }, `Current: ${config.altitude_m} m`)
        ),

        e('div', { className: 'card' },
            e('div', { className: 'values' },
                e('div', { className: 'value' }, e('strong', null, 'BMP Temperature'), e('div', null, last && last.bmp_temp !== undefined ? `${last.bmp_temp.toFixed(1)} °C` : '—')),
                e('div', { className: 'value' }, e('strong', null, 'DHT Temperature'), e('div', null, last && last.dht_temp !== undefined ? `${last.dht_temp.toFixed(1)} °C` : '—')),
                e('div', { className: 'value' }, e('strong', null, 'Humidity'), e('div', null, last && last.dht_hum ? `${last.dht_hum.toFixed(1)} %` : '—')),
                e('div', { className: 'value' }, e('strong', null, 'Pressure'), e('div', null, last && last.bmp_pressure ? `${last.bmp_pressure.toFixed(1)} hPa` : '—')),
                e('div', { className: 'value' }, e('strong', null, 'SL Pressure'), e('div', null, last && last.bmp_sealevel ? `${last.bmp_sealevel.toFixed(1)} hPa` : '—')),
                e('div', { className: 'value' }, e('strong', null, 'MQ Raw'), e('div', null, last ? `${last.mq_raw}` : '—'))
            ),
            e('div', { className: 'chart-main' }, e('canvas', { id: 'tempChart' })),
            e('div', { className: 'chart-grid' }, e('div', { className: 'chart-card' }, e('canvas', { id: 'humChart' })), e('div', { className: 'chart-card' }, e('canvas', { id: 'presChart' })), e('div', { className: 'chart-card' }, e('canvas', { id: 'mqChart' })))
        ),

        e('div', { style: { marginTop: 10, fontSize: 13, color: '#334155' } }, `Last seen: ${lastSeenDisplay}`),

        e('div', { className: 'card' }, e('h4', null, 'Recent readings (latest 10)'), e('pre', null, (() => {
            const fmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kathmandu' });
            const recent = data.slice(-10).reverse().map(r => {
                const copy = Object.assign({}, r);
                try { copy.receivedAt = fmt.format(new Date(r.receivedAt)); } catch (e) { const dt = new Date(r.receivedAt); const off = (5 * 60 + 45) * 60 * 1000; copy.receivedAt = new Date(dt.getTime() + off).toISOString(); }
                return copy;
            });
            return JSON.stringify(recent, null, 2);
        })()))
    );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
