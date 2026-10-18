// Thin wrappers over the Flask API. Every endpoint and payload here is the
// same one the dashboard has always used - see the routes in app.py.

async function request(path, options) {
    const response = await fetch(path, options);
    let data = null;
    try {
        data = await response.json();
    } catch {
        // non-JSON body - fall through to the status check
    }
    if (!response.ok) {
        throw new Error((data && data.error) || `${path} failed (${response.status})`);
    }
    return data;
}

export const get = (path) => request(path);

export const post = (path, body) =>
    request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

// Control actions (the only writes the dashboard makes)
export const setGrowthStage = (stage) => post("/api/growth_stage", { growth_stage: stage });
export const saveThreshold = (stageName, moistureThreshold) =>
    post("/api/growth_stages", { stage_name: stageName, moisture_threshold: moistureThreshold });
export const setAutoMode = (autoMode) => post("/api/auto_mode", { auto_mode: autoMode });
export const setPump = (pumpOn) => post("/api/pump", { pump_on: pumpOn });
export const setScenario = (scenario) => post("/api/scenario", { scenario });
export const setSimulatorEnabled = (enabled) => post("/api/data_source", { simulator_enabled: enabled });
