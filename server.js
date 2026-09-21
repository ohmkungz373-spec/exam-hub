const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, 'index.html');

// ไฟล์ .html ที่ไม่ใช่วิชา (ไม่เสิร์ฟ และไม่แสดงบน Hub)
const NON_SUBJECT_FILES = new Set(['index.html', 'template_subject.html']);

// โฟลเดอร์เก็บไฟล์วิชา: หาโฟลเดอร์ชื่อ "Subject" (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ในโฟลเดอร์โปรเจกต์
// ตั้งเองได้ด้วย env SUBJECT_DIR  |  ถ้าไม่พบโฟลเดอร์ → ถอยกลับไปอ่านจากโฟลเดอร์หลักเหมือนเดิม
function findSubjectDir() {
  if (process.env.SUBJECT_DIR) return path.resolve(ROOT, process.env.SUBJECT_DIR);
  const hit = fs.readdirSync(ROOT, { withFileTypes: true })
    .find(d => d.isDirectory() && d.name.toLowerCase() === 'subject');
  return hit ? path.join(ROOT, hit.name) : ROOT;
}
const SUBJECT_DIR = findSubjectDir();

// รายชื่อไฟล์เนื้อหาวิชาที่อนุญาตให้เสิร์ฟแบบ static
// = ทุกไฟล์ .html ในโฟลเดอร์ Subject ยกเว้นไฟล์ตามด้านบน → วางไฟล์วิชาใหม่ลงโฟลเดอร์ Subject แล้วรีสตาร์ท ก็เสิร์ฟได้เลย
// (URL ยังเป็น /ชื่อวิชา และ /ชื่อวิชา.html เหมือนเดิม ไม่ต้องแก้ index.html)
const docFiles = fs.readdirSync(SUBJECT_DIR).filter(f => f.endsWith('.html') && !NON_SUBJECT_FILES.has(f));

// พรีโหลดทุกไฟล์ไว้ในหน่วยความจำ + บีบอัดล่วงหน้าด้วย gzip ครั้งเดียวตอนสตาร์ท
// (ไม่ต้องอ่านไฟล์จาก disk หรือ gzip ซ้ำทุก request เร็วขึ้นมาก)
const cache = new Map();

function loadIntoCache(filename, absPath) {
  const raw = fs.readFileSync(absPath);
  const gzipped = zlib.gzipSync(raw, { level: 9 });
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('hex') + '"';
  cache.set(filename, { raw, gzipped, etag });
}

loadIntoCache('index.html', INDEX_PATH);
docFiles.forEach(f => loadIntoCache(f, path.join(SUBJECT_DIR, f)));

// ===== รายการวิชาสำหรับหน้า Hub (สร้างอัตโนมัติจากไฟล์วิชา → /subjects.json) =====
// id ของวิชา = ชื่อไฟล์ (ไม่รวม .html) เสมอ จึงไม่มีทางไม่ตรงกับ URL
// อ่านข้อมูลวิชาจากไฟล์ได้ 2 แบบ:
//   1) <script id="subject-data">  (แบบเทมเพลตใหม่ template_subject.html) → รัน const SUBJECT / topics ใน sandbox
//   2) <script type="application/json" id="subject-meta">  (ไฟล์วิชาเดิม) → JSON ธรรมดา
function readSubjectInfo(raw) {
  const html = raw.toString('utf8');

  const meta = html.match(/<script\b[^>]*\bid=["']subject-meta["'][^>]*>([\s\S]*?)<\/script>/i);
  if (meta) return JSON.parse(meta[1]);

  const data = html.match(/<script\b[^>]*\bid=["']subject-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (data) {
    const out = vm.runInNewContext(
      data[1] + '\n;JSON.stringify({ meta: SUBJECT, topics: topics.map(t => t.title) })',
      {}, { timeout: 1000 }
    );
    const parsed = JSON.parse(out);
    return Object.assign({}, parsed.meta, { topics: parsed.topics });
  }
  return null;
}

function buildRegistry() {
  const subjects = [];
  docFiles.forEach(f => {
    const id = f.replace(/\.html$/, '');
    try {
      const info = readSubjectInfo(cache.get(f).raw);
      if (!info) { console.warn(`[registry] ข้าม ${f}: ไม่พบ subject-data / subject-meta`); return; }
      subjects.push({
        id,
        icon: info.icon || '📖',
        name: info.name || id,
        examDay: info.examDay || '',
        order: Number.isFinite(info.order) ? info.order : 999,
        topics: Array.isArray(info.topics) ? info.topics : []
      });
    } catch (err) {
      console.warn(`[registry] ข้าม ${f}: อ่านข้อมูลวิชาไม่สำเร็จ (${err.message})`);
    }
  });
  subjects.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // วันสอบ (แท็บบนหน้า Hub) อ่านจาก hub.config.json
  let days = [];
  try {
    days = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub.config.json'), 'utf8')).days || [];
  } catch (err) {
    console.warn('[registry] อ่าน hub.config.json ไม่ได้ → ไม่แสดงแท็บวันสอบ');
  }
  return { days, subjects };
}

const registryRaw = Buffer.from(JSON.stringify(buildRegistry()), 'utf8');
cache.set('subjects.json', {
  raw: registryRaw,
  gzipped: zlib.gzipSync(registryRaw, { level: 9 }),
  etag: '"' + crypto.createHash('sha1').update(registryRaw).digest('hex') + '"',
  type: 'application/json; charset=utf-8'
});

function sendCached(req, res, filename) {
  const entry = cache.get(filename);

  // ถ้าเบราว์เซอร์มีไฟล์เดิมอยู่แล้ว (ETag ตรงกัน) ตอบ 304 ไม่ต้องส่งเนื้อหาซ้ำ
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { 'ETag': entry.etag });
    return res.end();
  }

  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  const headers = {
    'Content-Type': entry.type || 'text/html; charset=utf-8',
    'ETag': entry.etag,
    // must-revalidate: เบราว์เซอร์ต้องเช็คกับ server ทุกครั้งว่าของใหม่กว่าไหม (ผ่าน ETag)
    // ถ้าไฟล์ไม่เปลี่ยน server ตอบ 304 ทันทีโดยไม่ต้องส่งไฟล์ซ้ำ (เร็วเหมือนเดิม)
    // แต่ถ้าไฟล์เปลี่ยน (อัปเดตเนื้อหาใหม่) ผู้ใช้จะได้ของใหม่ทันที ไม่ค้าง cache เก่าเหมือนที่ผ่านมา
    'Cache-Control': (filename === 'index.html' || filename === 'subjects.json')
      ? 'no-cache'
      : 'public, max-age=0, must-revalidate',
  };
  if (acceptsGzip) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(entry.gzipped);
  } else {
    res.writeHead(200, headers);
    res.end(entry.raw);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const filename = pathname.replace(/^\/+/, ''); // ตัด / นำหน้าออก

  if (cache.has(filename) && filename !== 'index.html') {
    return sendCached(req, res, filename);
  }

  // ไม่ว่าจะขอ path ไหนนอกจากนี้ ให้ตอบ index.html เสมอ เพื่อให้ client-side router (pushState) จัดการเอง
  sendCached(req, res, 'index.html');
});

server.listen(PORT, () => {
  console.log(`Exam Hub server running on port ${PORT} (${docFiles.length} subject docs from ${path.relative(ROOT, SUBJECT_DIR) || '.'} cached + gzipped)`);
  if (!docFiles.length) console.warn(`[registry] ไม่พบไฟล์วิชา .html ใน ${SUBJECT_DIR}`);
});
