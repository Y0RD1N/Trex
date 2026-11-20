// La ventanita del botón de la extensión: emparejar con trex y compartir la pestaña actual.
const $ = id => document.getElementById(id);
const STATES = {
  "sin-emparejar": "Sin emparejar",
  conectando: "Conectando con trex…",
  conectado: "Conectado con trex",
  // También lo que se ve cuando la persona apaga «Tu navegador» en trex: la extensión sigue emparejada.
  "sin-trex": "trex no responde: ¿está abierto con «Tu navegador» activado?",
  rechazado: "trex desvinculó este navegador",
};

const ask = message => chrome.runtime.sendMessage(message).then(reply => {
  if (!reply?.ok) throw new Error(reply?.error || "No se pudo completar.");
  return reply.value;
});

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

function render(view) {
  $("status").textContent = STATES[view.state] ?? view.state;
  $("status").dataset.state = view.state;
  $("pairing").hidden = view.paired;
  $("paired").hidden = !view.paired;
  if (!view.paired) {
    if (!$("port").value) $("port").value = view.port;
    if (view.state === "rechazado" && view.error) showError(view.error);
    return;
  }
  const { tab } = view;
  const share = $("share");
  share.disabled = !tab || (!tab.shared && !tab.shareable);
  share.classList.toggle("is-shared", !!tab?.shared);
  share.textContent = tab?.shared ? "Dejar de compartir esta pestaña" : "Compartir esta pestaña con trex";
  share.dataset.tab = tab?.id ?? "";
  share.dataset.shared = tab?.shared ? "1" : "";
  $("share-note").textContent = tab?.shared
    ? "Los agentes de trex pueden verla y manejarla, con tu sesión iniciada en este sitio."
    : tab && !tab.shareable ? "Esta página no se puede compartir (solo sitios web)."
    : "Los agentes solo alcanzan las pestañas del grupo «trex».";
  $("count").textContent = view.sharedCount === 1 ? "1 pestaña compartida" : `${view.sharedCount} pestañas compartidas`;
  $("retry").hidden = view.state !== "sin-trex";
}

async function refresh(action) {
  try {
    showError("");
    render(await ask(action));
  } catch (error) {
    showError(error.message);
  }
}

$("pair-form").addEventListener("submit", event => {
  event.preventDefault();
  void refresh({ type: "pair", code: $("code").value, port: $("port").value });
});
$("share").addEventListener("click", () => {
  const tabId = Number($("share").dataset.tab);
  if (tabId) void refresh({ type: $("share").dataset.shared ? "unshare" : "share", tabId });
});
$("retry").addEventListener("click", () => void refresh({ type: "retry" }));
$("unpair").addEventListener("click", () => void refresh({ type: "unpair" }));
chrome.runtime.onMessage.addListener(message => { if (message?.type === "state") void refresh({ type: "status" }); });

void refresh({ type: "status" });
