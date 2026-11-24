// La ventanita del botón de la extensión: emparejar con trex y compartir la pestaña actual
// (con cualquier chat, en el grupo común «trex», o con uno concreto que ya tenga grupo).
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
  const where = tab?.where ?? "fuera";
  const shared = where !== "fuera";
  const share = $("share");
  share.disabled = !tab || (!shared && !tab.shareable);
  share.classList.toggle("is-shared", shared);
  share.textContent = shared ? "Dejar de compartir esta pestaña" : "Compartir esta pestaña";
  share.dataset.tab = tab?.id ?? "";
  share.dataset.shared = shared ? "1" : "";
  // Con quién: el grupo común (cualquier chat puede tomarla) o un chat que ya tenga grupo.
  const chats = view.chats ?? [];
  const target = $("target");
  const previous = target.value;
  target.replaceChildren(new Option("Cualquier chat (grupo común «trex»)", ""), ...chats.map(chat => new Option(`Solo ${chat.title}`, chat.owner)));
  target.value = chats.some(chat => chat.owner === previous) ? previous : "";
  $("target-row").hidden = shared || !tab?.shareable || !chats.length;
  $("share-note").textContent = where === "chat"
    ? `La está usando el chat «${tab.group}». Solo ese chat puede verla y manejarla, con tu sesión iniciada en este sitio.`
    : where === "comun" ? "Está en el grupo común «trex»: el primer chat que la use se la queda y pasa a su grupo, con tu sesión iniciada en este sitio."
    : tab && !tab.shareable ? "Esta página no se puede compartir (solo sitios web)."
    : "Cada chat solo alcanza su grupo «trex · …» y las pestañas que le compartas.";
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
  if (!tabId) return;
  void refresh($("share").dataset.shared ? { type: "unshare", tabId } : { type: "share", tabId, owner: $("target").value || null });
});
$("retry").addEventListener("click", () => void refresh({ type: "retry" }));
$("unpair").addEventListener("click", () => void refresh({ type: "unpair" }));
chrome.runtime.onMessage.addListener(message => { if (message?.type === "state") void refresh({ type: "status" }); });

void refresh({ type: "status" });
