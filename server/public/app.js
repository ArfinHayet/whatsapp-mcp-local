const element = (id) => document.getElementById(id);
const settings = {
  codex: "MCP settings or ~/.codex/config.toml",
  claude: "~/Library/Application Support/Claude/claude_desktop_config.json",
  hermes: "~/.hermes/config.yaml",
};
const statusLabels = {
  starting: "Starting", connected: "Connected", connecting: "Connecting",
  pairing_required: "Pairing required", pairing: "Waiting for scan", offline: "Offline",
  worker_unavailable: "Bridge unavailable", stopping: "Stopping",
};
const pairInstructions = "On your phone, open WhatsApp → Linked Devices → Link a Device.";
const pairingHelp = {
  qr_expired: "The QR expired. Requesting a fresh code…",
  qr_setup_failed: "Could not start pairing. Select Get a new QR to retry.",
  pair_connection_failed: "Could not connect to WhatsApp. Check your internet connection and retry.",
  client_outdated: "WhatsApp rejected this bridge version. Update the app before trying again.",
  pair_failed: "WhatsApp could not finish pairing. Select Get a new QR and try again.",
};
let configs = {};
let mode = "";
let refreshing = false;
let lastInstance = "";
let nextPairAttempt = 0;
const notice = (message) => { element("notice").textContent = message; };

async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    notice("Copied.");
  } catch {
    notice("Clipboard unavailable. Select the text and copy it manually.");
  }
}

function showConfig() {
  const client = element("client").value;
  element("config-file").textContent = settings[client];
  element("config").value = configs[client] || "";
  element("copy").disabled = !configs[client];
}

async function showFiles() {
  const entries = await api("/api/assets");
  const rows = entries.map((file) => {
    const item = document.createElement("li");
    const name = document.createElement("a");
    name.href = "/api/assets/" + encodeURIComponent(file.id);
    name.textContent = file.filename;
    const size = document.createElement("span");
    size.textContent = new Intl.NumberFormat(undefined, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 })
      .format(file.size_bytes / 1024);
    const id = document.createElement("code");
    id.textContent = file.id;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy file ID";
    button.addEventListener("click", () => void copy(file.id));
    item.append(name, size, id, button);
    return item;
  });
  element("files").replaceChildren(...rows);
  element("empty-files").hidden = rows.length !== 0;
}

function updateControls(enabled) {
  for (const name of ["restart", "stop", "upload-button"]) element(name).disabled = !enabled;
}

function clearQR() {
  const image = element("qr");
  image.hidden = true;
  image.removeAttribute("src");
}

async function refresh() {
  if (refreshing || mode === "stop") return;
  refreshing = true;
  try {
    const data = await api("/api/status");
    if (mode === "restart" && data.instance === lastInstance) return;
    if (data.state !== "running") {
      element("connection").textContent = statusLabels[data.state] || data.state;
      updateControls(false);
      return;
    }
    if (lastInstance !== data.instance) {
      configs = await api("/api/config");
      await showFiles();
      showConfig();
      if (mode === "restart") notice("Service restarted.");
      lastInstance = data.instance;
      mode = "";
    }
    updateControls(!mode);
    element("connection").textContent = statusLabels[data.whatsapp] || data.whatsapp;
    const help = element("pair-help");
    help.hidden = data.whatsapp === "connected";
    help.textContent = data.whatsapp === "connecting" ? "Finishing the WhatsApp connection…"
      : pairingHelp[data.pairingError] || pairInstructions;
    element("pair").hidden = data.whatsapp === "connected";
    element("pair").textContent = data.pairingError ? "Get a new QR" : "Request pairing QR";
    element("pair").disabled = data.whatsapp !== "pairing_required" || Boolean(mode);
    if (data.whatsapp === "pairing") {
      const { image } = await api("/api/pairing");
      if (mode) return;
      if (image) {
        element("qr").src = image;
        element("qr").hidden = false;
      } else clearQR();
    } else {
      clearQR();
      const retryExpired = data.pairingError === "qr_expired";
      if (data.whatsapp === "pairing_required" && (!data.pairingError || retryExpired) && Date.now() >= nextPairAttempt) {
        nextPairAttempt = Date.now() + 15_000;
        await api("/api/pairing", { method: "POST" });
      }
    }
  } catch {
    updateControls(false);
    clearQR();
    element("connection").textContent = mode === "restart" ? "Restarting" : "Service unavailable";
  } finally {
    refreshing = false;
  }
}

element("client").addEventListener("change", showConfig);
element("copy").addEventListener("click", () => void copy(element("config").value));
element("copy-start").addEventListener("click", () => void copy(element("start-command").textContent));
element("pair").addEventListener("click", async () => {
  try {
    await api("/api/pairing", { method: "POST" });
    void refresh();
  } catch (error) { notice(error.message); }
});
element("upload").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = element("file").files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return notice("Files must be 20 MiB or smaller.");
  element("upload-button").disabled = true;
  notice("Uploading…");
  try {
    const asset = await api("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-WhatsApp-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    element("upload").reset();
    await showFiles();
    notice("Saved " + asset.filename + ".");
  } catch (error) { notice(error.message); }
  finally { element("upload-button").disabled = Boolean(mode); }
});
for (const action of ["restart", "stop"]) {
  element(action).addEventListener("click", async () => {
    if (mode || (action === "stop" && !window.confirm("Stop both services and disable automatic startup?"))) return;
    mode = action;
    updateControls(false);
    element("pair").disabled = true;
    clearQR();
    try {
      const data = await api("/api/service/" + action, { method: "POST" });
      if (action === "stop") {
        element("connection").textContent = "Stopping";
        element("start-command").textContent = data.startCommand;
        element("start-instructions").hidden = false;
        notice("Automatic startup is disabled. Both services are shutting down.");
      } else {
        element("connection").textContent = "Restarting";
        notice("Waiting for the service to come back.");
      }
    } catch (error) {
      mode = "";
      notice(error.message);
      void refresh();
    }
  });
}
showConfig();
void refresh();
setInterval(() => void refresh(), 1500);
