// build.js — สร้างโฟลเดอร์ public/ สำหรับ deploy บน Vercel (เว็บ static ล้วน ไม่ต้องมี server)
// ทำสิ่งเดียวกับ server.js: อ่านไฟล์วิชาในโฟลเดอร์ Subject → สร้าง subjects.json → คัดลอกทุกอย่างไป public/
// รัน:  node build.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'public');
const NON_SUBJECT_FILES = new Set(['index.html', 'template_subject.html']);

// หาโฟลเดอร์ "Subject" (ไม่สนตัวพิมพ์เล็ก/ใหญ่ — สำคัญบน Vercel ที่เป็น Linux แยกตัวพิมพ์)
function findSubjectDir() {
  if (process.env.SUBJECT_DIR) return path.resolve(ROOT, process.env.SUBJECT_DIR);
  const hit = fs.readdirSync(ROOT, { withFileTypes: true })
    .find(d => d.isDirectory() && d.name.toLowerCase() === 'subject');
  return hit ? path.join(ROOT, hit.name) : ROOT;
}

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

const SUBJECT_DIR = findSubjectDir();
const docFiles = fs.readdirSync(SUBJECT_DIR)
  .filter(f => f.endsWith('.html') && !NON_SUBJECT_FILES.has(f))
  .sort();

if (!docFiles.length) {
  console.error(`[build] ไม่พบไฟล์วิชา .html ใน ${SUBJECT_DIR}`);
  process.exit(1); // ให้ build ล้มชัดเจน ดีกว่า deploy เว็บเปล่า
}

// เริ่มสะอาดทุกครั้ง
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const subjects = [];
docFiles.forEach(f => {
  const id = f.replace(/\.html$/, '');
  const raw = fs.readFileSync(path.join(SUBJECT_DIR, f));
  fs.writeFileSync(path.join(OUT, f), raw);
  try {
    const info = readSubjectInfo(raw);
    if (!info) { console.warn(`[build] ข้าม ${f}: ไม่พบ subject-data / subject-meta`); return; }
    subjects.push({
      id,
      icon: info.icon || '📖',
      name: info.name || id,
      examDay: info.examDay || '',
      order: Number.isFinite(info.order) ? info.order : 999,
      topics: Array.isArray(info.topics) ? info.topics : []
    });
  } catch (err) {
    console.warn(`[build] ข้าม ${f}: อ่านข้อมูลวิชาไม่สำเร็จ (${err.message})`);
  }
});
subjects.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

let days = [];
try {
  days = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub.config.json'), 'utf8')).days || [];
} catch (err) {
  console.warn('[build] อ่าน hub.config.json ไม่ได้ → ไม่แสดงแท็บวันสอบ');
}

fs.writeFileSync(path.join(OUT, 'subjects.json'), JSON.stringify({ days, subjects }));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));

console.log(`[build] เสร็จ: ${subjects.length} วิชา, ${days.length} วันสอบ → public/`);
