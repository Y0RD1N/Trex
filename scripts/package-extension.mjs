// Empaqueta «trex para tu navegador» (la carpeta `extension/`) en un .zip listo para subir a
// la Chrome Web Store y a Edge Add-ons: solo los archivos que usa la extensión, sin README ni
// pruebas, con manifest.json en la raíz. Lo sube la persona con su cuenta de desarrollador
// (pasos en docs/extension-tiendas.md).
//
//   node scripts/package-extension.mjs [carpeta de salida]
//
// Sin carpeta, en una temporal nueva. Nunca dentro del repositorio.
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = join(ROOT, "extension");
/** Lo que entra: código, páginas, estilos e iconos. */
const ALLOWED = /\.(js|json|html|css|png)$/i;
/** Los que son texto. */
const TEXT = /\.(js|json|html|css)$/i;
/** Lo que nunca entra: documentación, pruebas y archivos ocultos. */
const EXCLUDED = /(^|\/)(readme[^/]*|[^/]*\.md|[^/]*\.test\.[^/]+|\.[^/]*)$/i;

// --- Dónde se deja ----------------------------------------------------------------

const exists = path => access(path).then(() => true, () => false);

/** El repositorio y, si esto es un worktree, también el repositorio que lo contiene. */
async function repositories() {
  const roots = [ROOT];
  for (let dir = dirname(ROOT); dir !== dirname(dir); dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) roots.push(dir);
  }
  return roots;
}

const inside = (base, path) => {
  const rest = relative(base, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
};

// --- Qué entra --------------------------------------------------------------------

async function listFiles(dir = EXTENSION, prefix = "") {
  const names = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (EXCLUDED.test(name)) continue;
    if (entry.isDirectory()) names.push(...await listFiles(join(dir, entry.name), `${name}/`));
    else if (entry.isFile() && ALLOWED.test(name)) names.push(name);
  }
  return names;
}

/** El manifiesto tiene lo que piden las tiendas, y todo lo que nombra va en el paquete. */
function checkManifest(manifest, names) {
  if (manifest.manifest_version !== 3) throw new Error("El manifiesto debe ser de la versión 3.");
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version ?? ""))) throw new Error(`Versión no válida en el manifiesto: ${manifest.version}`);
  // `key` fija el id de la extensión cargada a mano; las tiendas no la aceptan.
  if ("key" in manifest) throw new Error("Quita «key» del manifiesto: las tiendas la rechazan.");
  if (!manifest.icons?.["128"]) throw new Error("Las tiendas piden un icono de 128 px en el manifiesto.");
  if (String(manifest.description ?? "").length > 132) throw new Error("La descripción del manifiesto pasa de 132 caracteres.");
  const named = [manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})];
  for (const name of named.filter(Boolean)) {
    if (!names.includes(name)) throw new Error(`El manifiesto nombra «${name}», que no entra en el paquete.`);
  }
}

// --- Zip ----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fecha fija (1 de enero de 2026): el mismo código da siempre el mismo .zip.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
/** Hecho en «Unix», con permisos rw-r--r--: así se descomprime igual en todas partes. */
const MADE_BY = (3 << 8) | 20;
const FILE_MODE = (0o100644 << 16) >>> 0;

/** Un .zip normal: cada archivo comprimido con deflate (o guardado tal cual si no gana nada). */
export function zip(files) {
  const parts = [], directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(FILE_MODE, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

/** Lo que hay dentro de un .zip (para las pruebas y para comprobar el paquete). */
export function zipEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("No es un .zip.");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("Directorio del .zip dañado.");
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = () => {
      const body = buffer.subarray(start, start + packed);
      return method === 8 ? inflateRawSync(body) : Buffer.from(body);
    };
    entries.push({ name, size, method, data, text: () => data().toString("utf8") });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

// --- Empaquetar -----------------------------------------------------------------------

/** Crea `trex-extension-<versión>.zip` en `outDir` (o en una carpeta temporal nueva). */
export async function packageExtension(outDir) {
  const target = resolve(outDir ?? await mkdtemp(join(tmpdir(), "trex-extension-")));
  for (const repository of await repositories()) {
    if (inside(repository, target)) throw new Error(`Deja el paquete fuera del repositorio (${repository}), no en ${target}.`);
  }
  const manifest = JSON.parse(await readFile(join(EXTENSION, "manifest.json"), "utf8"));
  const names = await listFiles();
  // El manifiesto primero; lo demás, en orden.
  const entries = ["manifest.json", ...names.filter(name => name !== "manifest.json").sort()];
  checkManifest(manifest, entries);
  // Los textos, con saltos de línea LF aunque la copia de trabajo tenga CRLF: el mismo código da el mismo paquete.
  const files = await Promise.all(entries.map(async name => {
    const data = await readFile(join(EXTENSION, ...name.split("/")));
    return { name, data: TEXT.test(name) ? Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : data };
  }));
  await mkdir(target, { recursive: true });
  const file = join(target, `trex-extension-${manifest.version}.zip`);
  await writeFile(file, zip(files));
  return { file, entries, version: manifest.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageExtension(process.argv[2]).then(({ file, entries }) => {
    console.log(`Paquete listo: ${file}`);
    for (const name of entries) console.log(`  ${name}`);
  }, error => {
    console.error(`No se pudo empaquetar la extensión: ${error.message}`);
    process.exitCode = 1;
  });
}
