"use strict";

const state = {
    records: [],
    deviceKey: "",
    range: "24h"
};

const elements = {
    status: document.getElementById("load-status"),
    error: document.getElementById("error-message"),
    range: document.getElementById("range-select"),
    device: document.getElementById("device-select"),
    reload: document.getElementById("reload-button"),
    jsonLink: document.getElementById("json-link")
};

const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const firstDataDate = "2026-11-22";
const dailyFileCache = new Map();
const filterThresholds = {
    temperature: 3,
    humidity: 15,
    co2: 300
};
const filterRecoveryCount = 3;
const filterResetGapMs = 30 * 60 * 1000;
const plotConfig = {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d"]
};

function parseTimestamp(value) {
    if (typeof value !== "string") return null;
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/
    );
    if (!match) return null;

    const date = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6] || "0")
    );
    return Number.isNaN(date.getTime()) ? null : date;
}

function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatValue(value, unit = "") {
    const number = asNumber(value);
    return number === null ? "--" : `${numberFormat.format(number)}${unit}`;
}

function deviceKey(device) {
    if (typeof device.device_id === "string" && device.device_id.length > 0) {
        return `id:${device.device_id}`;
    }
    return `type:${device.device_type || "unknown"}`;
}

function deviceTypeLabel(type) {
    const labels = {
        "Hub 2": "ハブ2内蔵センサー",
        "Hub 3": "ハブ3内蔵センサー",
        Meter: "温湿度計",
        MeterPro: "温湿度計Pro",
        "MeterPro(CO2)": "CO₂温湿度計Pro",
        WoIOSensor: "防水温湿度計"
    };
    return labels[type] || type || "機器";
}

function collectDevices(records) {
    const devices = new Map();
    const typeCounts = new Map();
    for (const record of records) {
        if (!Array.isArray(record.switchbot_devices)) continue;
        for (const device of record.switchbot_devices) {
            if (!device || typeof device !== "object") continue;
            const key = deviceKey(device);
            if (!devices.has(key)) {
                const type = device.device_type || "名称未設定";
                const typeIndex = (typeCounts.get(type) || 0) + 1;
                typeCounts.set(type, typeIndex);
                devices.set(key, {
                    key,
                    name: device.device_label || `${deviceTypeLabel(type)} ${typeIndex}`
                });
            }
        }
    }
    return [...devices.values()]
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function collectCo2Devices(records) {
    const devices = new Map();
    for (const record of records) {
        if (!Array.isArray(record.switchbot_devices)) continue;
        for (const device of record.switchbot_devices) {
            if (
                !device ||
                typeof device !== "object" ||
                typeof device.device_type !== "string" ||
                device.device_type.toLowerCase().replace(/\s/g, "") !== "meterpro(co2)"
            ) {
                continue;
            }
            const key = deviceKey(device);
            if (!devices.has(key)) {
                devices.set(key, {
                    key,
                    name: device.device_label || deviceTypeLabel(device.device_type)
                });
            }
        }
    }
    return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function filterSeries(records, valueSelector, threshold, range = null) {
    const filtered = Array(records.length).fill(null);
    const history = [];
    let candidates = [];
    let lastValidAt = null;

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const timestamp = record.date.getTime();
        const value = asNumber(valueSelector(record));

        if (lastValidAt !== null && timestamp - lastValidAt >= filterResetGapMs) {
            history.length = 0;
            candidates = [];
            lastValidAt = null;
        }

        if (
            value === null ||
            (range && (value < range[0] || value > range[1]))
        ) {
            candidates = [];
            continue;
        }

        if (history.length < filterRecoveryCount) {
            filtered[index] = value;
            history.push(value);
            lastValidAt = timestamp;
            continue;
        }

        if (Math.abs(value - median(history)) <= threshold) {
            filtered[index] = value;
            history.push(value);
            if (history.length > filterRecoveryCount) history.shift();
            candidates = [];
            lastValidAt = timestamp;
            continue;
        }

        if (
            candidates.length > 0 &&
            timestamp - candidates[candidates.length - 1].timestamp >= filterResetGapMs
        ) {
            candidates = [];
        }
        if (
            candidates.length > 0 &&
            Math.abs(value - median(candidates.map((candidate) => candidate.value))) > threshold
        ) {
            candidates = [];
        }
        candidates.push({ index, timestamp, value });

        if (candidates.length === filterRecoveryCount) {
            for (const candidate of candidates) {
                filtered[candidate.index] = candidate.value;
                history.push(candidate.value);
                if (history.length > filterRecoveryCount) history.shift();
            }
            candidates = [];
            lastValidAt = timestamp;
        }
    }

    return filtered;
}

function updateDeviceOptions(records) {
    const devices = collectDevices(records);
    const previousKey = state.deviceKey;
    elements.device.replaceChildren();

    if (devices.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "機器データなし";
        elements.device.append(option);
        state.deviceKey = "";
        return;
    }

    for (const device of devices) {
        const option = document.createElement("option");
        option.value = device.key;
        option.textContent = device.name;
        elements.device.append(option);
    }

    state.deviceKey = devices.some((device) => device.key === previousKey)
        ? previousKey
        : devices[0].key;
    elements.device.value = state.deviceKey;
}

function getDevice(record, key = state.deviceKey) {
    if (!key || !Array.isArray(record.switchbot_devices)) return null;
    return record.switchbot_devices.find(
        (device) => device && typeof device === "object" && deviceKey(device) === key
    ) || null;
}

function getVisibleRecords(records = state.records) {
    if (state.range === "all" || records.length === 0) return records;

    const hours = state.range === "24h" ? 24 : state.range === "7d" ? 24 * 7 : 24 * 30;
    const end = records[records.length - 1].date.getTime();
    const start = end - hours * 60 * 60 * 1000;
    return records.filter((record) => record.date.getTime() >= start);
}

function setSummary(id, value) {
    document.getElementById(id).textContent = value;
}

function updateSummary(records) {
    const latest = records[records.length - 1];
    if (!latest) {
        for (const id of [
            "summary-time",
            "summary-state",
            "summary-room-temp",
            "summary-humidity",
            "summary-power",
            "summary-outdoor-temp"
        ]) {
            setSummary(id, "--");
        }
        return;
    }

    const operation = latest.ac_operation_status;
    setSummary("summary-time", latest.timestamp || "--");
    setSummary(
        "summary-state",
        operation === "on" ? "運転中" : operation === "off" ? "停止中" : "--"
    );
    setSummary("summary-room-temp", formatValue(latest.filtered.ac_indoor_temp, "°C"));
    setSummary("summary-humidity", formatValue(latest.filtered.ac_humidity, "%"));
    setSummary("summary-power", formatValue(latest.ac_power, " W"));
    setSummary("summary-outdoor-temp", formatValue(latest.filtered.ac_outdoor_temp, "°C"));
}

function baseLayout(yTitle, extra = {}) {
    return {
        autosize: true,
        margin: { l: 54, r: 24, t: 18, b: 88 },
        paper_bgcolor: "rgba(255,255,255,0)",
        plot_bgcolor: "rgba(255,255,255,0)",
        font: { family: "Segoe UI, Yu Gothic UI, Meiryo, sans-serif", color: "#52627a" },
        hovermode: "x unified",
        legend: { orientation: "h", y: 1.16, x: 0, font: { size: 11 } },
        xaxis: {
            type: "date",
            title: { text: "時刻（JST）" },
            tickformat: "%Y-%m-%d %H:%M",
            tickangle: -35,
            tickfont: { size: 9 },
            nticks: 4,
            gridcolor: "#edf1f6",
            linecolor: "#d8e0ea",
            automargin: true
        },
        yaxis: {
            title: { text: yTitle },
            gridcolor: "#edf1f6",
            zerolinecolor: "#d8e0ea",
            automargin: true
        },
        ...extra
    };
}

function lineTrace(name, rows, valueSelector, color, extra = {}) {
    return {
        type: "scatter",
        mode: "lines+markers",
        name,
        x: rows.map((record) => record.date),
        y: rows.map(valueSelector),
        xhoverformat: "%Y-%m-%d %H:%M",
        connectgaps: false,
        line: { color, width: 2 },
        marker: { size: 4 },
        ...extra
    };
}

function sparseMarkerText(rows, valueSelector, marker) {
    const validIndexes = [];
    for (let index = 0; index < rows.length; index += 1) {
        if (asNumber(valueSelector(rows[index])) !== null) {
            validIndexes.push(index);
        }
    }

    const markerCount = Math.min(30, validIndexes.length);
    const markerIndexes = new Set();
    for (let index = 0; index < markerCount; index += 1) {
        const validIndex = markerCount === 1
            ? 0
            : Math.round(index * (validIndexes.length - 1) / (markerCount - 1));
        markerIndexes.add(validIndexes[validIndex]);
    }
    return rows.map((_, index) => markerIndexes.has(index) ? marker : "");
}

function showEmptyMessage(id, message) {
    Plotly.react(
        id,
        [],
        {
            ...baseLayout(""),
            xaxis: { visible: false },
            yaxis: { visible: false },
            annotations: [{
                text: message,
                x: 0.5,
                y: 0.5,
                xref: "paper",
                yref: "paper",
                showarrow: false,
                font: { color: "#64748b", size: 14 }
            }]
        },
        plotConfig
    );
}

function operationBackgroundShapes(rows) {
    const shapes = [];
    let status = null;
    let start = null;
    let end = null;

    const finishSegment = () => {
        if (status !== null && start !== null && end !== null && end > start) {
            shapes.push({
                type: "rect",
                xref: "x",
                yref: "paper",
                x0: start,
                x1: end,
                y0: 0,
                y1: 1,
                fillcolor: status === "on"
                    ? "rgba(34, 197, 94, 0.08)"
                    : "rgba(100, 116, 139, 0.07)",
                line: { width: 0 },
                layer: "below"
            });
        }
        status = null;
        start = null;
        end = null;
    };

    for (let index = 0; index < rows.length - 1; index += 1) {
        const current = rows[index];
        const next = rows[index + 1];
        const currentStatus = current.ac_operation_status;
        if (
            (currentStatus !== "on" && currentStatus !== "off") ||
            next.date.getTime() - current.date.getTime() >= filterResetGapMs
        ) {
            finishSegment();
            continue;
        }

        if (currentStatus !== status) {
            finishSegment();
            status = currentStatus;
            start = current.date;
        }
        end = next.date;
    }

    finishSegment();
    return shapes;
}

function renderCharts(rows) {
    if (typeof Plotly === "undefined") {
        throw new Error("Plotly.jsを読み込めません。インターネット接続を確認してください。");
    }
    if (rows.length === 0) {
        for (const id of ["combined-chart", "temperature-chart", "outdoor-chart", "humidity-chart", "co2-chart", "power-chart", "operation-chart"]) {
            showEmptyMessage(id, "選択期間にデータがありません");
        }
        return;
    }

    const sensorColors = [
        "#1b9a83",
        "#d1495b",
        "#457b9d",
        "#f0a202",
        "#9b5de5",
        "#00a8e8",
        "#8d5a97",
        "#7c6a0a"
    ];
    const combinedPowerMarkers =
        sparseMarkerText(rows, (record) => record.ac_power, "⚡");
    const combinedFanMarkers =
        sparseMarkerText(rows, (record) => record.ac_fan_speed, "風");
    const combinedTraces = [
        lineTrace("エアコン室温", rows, (r) => r.filtered.ac_indoor_temp, "#2864dc"),
        lineTrace("エアコン外気温", rows, (r) => r.filtered.ac_outdoor_temp, "#e58a35"),
        lineTrace("エアコン設定温度", rows, (r) => asNumber(r.ac_target_temp), "#7b61c9", {
            line: { color: "#7b61c9", width: 1.5, dash: "dash" },
            marker: { size: 0 }
        }),
        ...collectDevices(state.records).map((device, index) =>
            lineTrace(
                device.name,
                rows,
                (record) => record.filtered.switchbot_temperatures.get(device.key),
                sensorColors[index % sensorColors.length]
            )
        ),
        lineTrace("エアコン消費電力", rows, (r) => asNumber(r.ac_power), "#c2410c", {
            yaxis: "y2",
            mode: "lines+text",
            text: combinedPowerMarkers,
            textposition: "middle center",
            textfont: { color: "#facc15", size: 20 },
            marker: { size: 0 }
        }),
        lineTrace("ファン速度設定値", rows, (r) => asNumber(r.ac_fan_speed), "#475569", {
            yaxis: "y3",
            mode: "lines+text",
            text: combinedFanMarkers,
            textposition: "middle center",
            textfont: { color: "#475569", size: 18 },
            marker: { size: 0 }
        })
    ];
    const combinedLayout = baseLayout("温度 (°C)", {
        margin: { l: 64, r: 190, t: 54, b: 92 },
        legend: { orientation: "h", y: 1.22, x: 0, font: { size: 10 } },
        yaxis2: {
            title: { text: "消費電力 (W)", font: { color: "#c2410c" } },
            tickfont: { color: "#c2410c" },
            overlaying: "y",
            side: "right",
            anchor: "free",
            position: 0.74,
            showgrid: false,
            automargin: true
        },
        yaxis3: {
            title: { text: "ファン速度設定値 (raw)", font: { color: "#475569" } },
            tickfont: { color: "#475569" },
            overlaying: "y",
            side: "right",
            anchor: "free",
            position: 0.86,
            showgrid: false,
            automargin: true
        }
    });
    combinedLayout.xaxis.domain = [0, 0.72];
    combinedLayout.shapes = operationBackgroundShapes(rows);
    Plotly.react("combined-chart", combinedTraces, combinedLayout, plotConfig);

    const temperatureTraces = [
        lineTrace("エアコン室温", rows, (r) => r.filtered.ac_indoor_temp, "#2864dc"),
        lineTrace("設定温度", rows, (r) => asNumber(r.ac_target_temp), "#7b61c9", {
            line: { color: "#7b61c9", width: 1.5, dash: "dash" },
            marker: { size: 0 }
        }),
        lineTrace(
            state.deviceKey ? elements.device.selectedOptions[0].textContent : "SwitchBot",
            rows,
            (r) => r.filtered.switchbot_temperature,
            "#1b9a83"
        )
    ];
    Plotly.react(
        "temperature-chart",
        temperatureTraces,
        baseLayout("温度 (°C)"),
        plotConfig
    );

    Plotly.react(
        "outdoor-chart",
        [lineTrace("エアコン外気温", rows, (r) => r.filtered.ac_outdoor_temp, "#e58a35")],
        baseLayout("外気温 (°C)"),
        plotConfig
    );

    const humidityTraces = [
        lineTrace("エアコン室内湿度", rows, (r) => r.filtered.ac_humidity, "#2864dc"),
        lineTrace(
            state.deviceKey ? elements.device.selectedOptions[0].textContent : "SwitchBot",
            rows,
            (r) => r.filtered.switchbot_humidity,
            "#1b9a83"
        )
    ];
    Plotly.react(
        "humidity-chart",
        humidityTraces,
        baseLayout("湿度 (%)", { yaxis: { range: [0, 100], dtick: 20, title: { text: "湿度 (%)" }, gridcolor: "#edf1f6", automargin: true } }),
        plotConfig
    );

    const co2Devices = collectCo2Devices(state.records);
    const co2Traces = co2Devices.map((device, index) =>
        lineTrace(
            device.name,
            rows,
            (record) => record.filtered.switchbot_co2.get(device.key),
            ["#8b5cf6", "#0891b2", "#db2777", "#65a30d"][index % 4]
        )
    );
    if (!co2Traces.some((trace) => trace.y.some((value) => value !== null))) {
        showEmptyMessage("co2-chart", "CO2センサーからの記録がありません");
    } else {
        Plotly.react(
            "co2-chart",
            co2Traces,
            baseLayout("CO2濃度 (ppm)"),
            plotConfig
        );
    }

    const powerTraces = [
        lineTrace("消費電力", rows, (r) => asNumber(r.ac_power), "#e58a35", {
            mode: "lines+text",
            text: rows.map((r) => asNumber(r.ac_power) === null ? "" : "⚡"),
            textposition: "middle center",
            textfont: { color: "#e58a35", size: 14 },
            marker: { size: 0 }
        }),
        lineTrace(
            "積算電力量",
            rows,
            (r) => asNumber(r.ac_cumulative_power_wh),
            "#2864dc",
            { yaxis: "y2" }
        )
    ];
    Plotly.react(
        "power-chart",
        powerTraces,
        baseLayout("消費電力 (W)", {
            yaxis2: {
                title: { text: "積算電力量 (Wh)" },
                overlaying: "y",
                side: "right",
                showgrid: false,
                automargin: true
            }
        }),
        plotConfig
    );

    const operationValues = rows.map((record) =>
        record.ac_operation_status === "on"
            ? 1
            : record.ac_operation_status === "off"
                ? 0
                : null
    );
    Plotly.react(
        "operation-chart",
        [{
            type: "scatter",
            mode: "lines+markers",
            name: "運転状態",
            x: rows.map((record) => record.date),
            y: operationValues,
            xhoverformat: "%Y-%m-%d %H:%M",
            connectgaps: false,
            line: { color: "#7b61c9", width: 2, shape: "hv" },
            marker: { size: 5 },
            customdata: rows.map((record) => record.ac_operation_status || "--"),
            hovertemplate: "%{customdata}<extra></extra>"
        }],
        baseLayout("", {
            margin: { l: 54, r: 24, t: 18, b: 88 },
            yaxis: {
                title: { text: "運転状態" },
                range: [-0.15, 1.15],
                tickvals: [0, 1],
                ticktext: ["停止", "運転"],
                gridcolor: "#edf1f6",
                automargin: true
            }
        }),
        plotConfig
    );
}

function render() {
    const indoorTemperatures = filterSeries(
        state.records,
        (record) => record.ac_indoor_temp,
        filterThresholds.temperature,
        [-127, 125]
    );
    const outdoorTemperatures = filterSeries(
        state.records,
        (record) => record.ac_outdoor_temp,
        filterThresholds.temperature,
        [-127, 125]
    );
    const airConditionerHumidity = filterSeries(
        state.records,
        (record) => record.ac_humidity,
        filterThresholds.humidity,
        [0, 100]
    );
    const switchbotDevices = collectDevices(state.records);
    const switchbotTemperaturesByDevice = new Map(
        switchbotDevices.map((device) => [
            device.key,
            filterSeries(
                state.records,
                (record) => getDevice(record, device.key)?.temperature,
                filterThresholds.temperature
            )
        ])
    );
    const switchbotHumidity = filterSeries(
        state.records,
        (record) => getDevice(record)?.humidity,
        filterThresholds.humidity,
        [0, 100]
    );
    const co2Devices = collectCo2Devices(state.records);
    const co2ValuesByDevice = new Map(
        co2Devices.map((device) => [
            device.key,
            filterSeries(
                state.records,
                (record) => getDevice(record, device.key)?.co2,
                filterThresholds.co2,
                [0, 9999]
            )
        ])
    );
    const filteredRecords = state.records.map((record, index) => ({
        ...record,
        filtered: {
            ac_indoor_temp: indoorTemperatures[index],
            ac_outdoor_temp: outdoorTemperatures[index],
            ac_humidity: airConditionerHumidity[index],
            switchbot_temperature: switchbotTemperaturesByDevice.get(state.deviceKey)?.[index] ?? null,
            switchbot_temperatures: new Map(
                [...switchbotTemperaturesByDevice].map(([key, values]) => [key, values[index]])
            ),
            switchbot_humidity: switchbotHumidity[index],
            switchbot_co2: new Map(
                [...co2ValuesByDevice].map(([key, values]) => [key, values[index]])
            )
        }
    }));
    const rows = getVisibleRecords(filteredRecords);
    updateSummary(rows);
    renderCharts(rows);
}

function dateKeyInJst(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const values = {};
    for (const part of parts) {
        if (part.type !== "literal") values[part.type] = part.value;
    }
    return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days))
        .toISOString()
        .slice(0, 10);
}

function dailyDatesForRange() {
    const today = dateKeyInJst(new Date());
    const endDate = today === firstDataDate ? today : shiftDateKey(today, -1);
    let startDate = firstDataDate;
    if (state.range !== "all") {
        const hours = state.range === "24h" ? 24 : state.range === "7d" ? 24 * 7 : 24 * 30;
        const startTime = Date.now() - (hours + 24) * 60 * 60 * 1000;
        startDate = dateKeyInJst(new Date(startTime));
    }
    if (startDate < firstDataDate) startDate = firstDataDate;
    if (startDate > endDate) return [];

    const dates = [];
    for (let date = startDate; date <= endDate; date = shiftDateKey(date, 1)) {
        dates.push(date);
    }
    return dates;
}

async function loadDailyFile(dateKey, forceRefresh) {
    const cached = dailyFileCache.get(dateKey);
    if (
        !forceRefresh &&
        cached &&
        (cached.records !== null || Date.now() - cached.loadedAt < 60_000)
    ) {
        return cached.records || [];
    }

    const fileName = `data_${dateKey.replace(/-/g, "")}.json`;
    const url = new URL(`./${fileName}`, document.baseURI);
    url.searchParams.set("_", Date.now().toString());
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) {
        dailyFileCache.set(dateKey, { records: null, loadedAt: Date.now() });
        return [];
    }
    if (!response.ok) {
        throw new Error(`${fileName}の取得に失敗しました (HTTP ${response.status})`);
    }

    const source = await response.json();
    if (!Array.isArray(source)) {
        throw new Error(`${fileName}の形式が配列ではありません。`);
    }
    dailyFileCache.set(dateKey, { records: source, loadedAt: Date.now() });
    return source;
}

let loadSequence = 0;

async function loadData(forceRefresh = false) {
    const requestId = ++loadSequence;
    if (forceRefresh) dailyFileCache.clear();
    elements.status.textContent = "JSONを読み込み中...";
    elements.error.hidden = true;
    try {
        const dates = dailyDatesForRange();
        const source = [];
        for (let offset = 0; offset < dates.length; offset += 8) {
            const batch = await Promise.all(
                dates.slice(offset, offset + 8).map((date) => loadDailyFile(date, forceRefresh))
            );
            source.push(...batch.flat());
            if (requestId !== loadSequence) return;
        }

        state.records = source
            .map((record) => ({
                ...record,
                date: parseTimestamp(record.timestamp)
            }))
            .filter((record) => record.date !== null)
            .sort((a, b) => a.date.getTime() - b.date.getTime());

        updateDeviceOptions(state.records);
        render();
        const latest = state.records[state.records.length - 1];
        if (latest) {
            const latestDate = latest.timestamp.slice(0, 10).replace(/-/g, "");
            elements.jsonLink.href = `./data_${latestDate}.json`;
            elements.jsonLink.hidden = false;
            elements.status.textContent =
                `${getVisibleRecords().length.toLocaleString("ja-JP")}件 · ${latest.timestamp}まで`;
        } else {
            elements.jsonLink.hidden = true;
            elements.status.textContent = "該当する日別データがありません";
        }
    } catch (error) {
        if (requestId !== loadSequence) return;
        elements.status.textContent = "読み込みエラー";
        elements.error.textContent = error instanceof Error ? error.message : String(error);
        elements.error.hidden = false;
        if (typeof Plotly !== "undefined" && state.records.length === 0) {
            for (const id of ["combined-chart", "temperature-chart", "outdoor-chart", "humidity-chart", "co2-chart", "power-chart", "operation-chart"]) {
                showEmptyMessage(id, "データを読み込めません");
            }
        }
    }
}

elements.range.addEventListener("change", () => {
    state.range = elements.range.value;
    loadData();
});
elements.device.addEventListener("change", () => {
    state.deviceKey = elements.device.value;
    render();
});
elements.reload.addEventListener("click", () => loadData(true));

loadData();
window.setInterval(() => loadData(), 60_000);
