const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage for question images
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'soal-' + unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Hanya file gambar (JPG, PNG, GIF, WEBP, SVG) yang diperbolehkan!'));
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// DATABASE SETUP & MIGRATION (better-sqlite3)
// --------------------------------------------------------------------------
const dbPath = path.join(__dirname, 'lomba.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Base Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS soal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapel TEXT NOT NULL,
    soal TEXT NOT NULL,
    kunci REAL NOT NULL,
    satuan TEXT DEFAULT '',
    toleransi REAL DEFAULT 0.01,
    waktu_tampil INTEGER DEFAULT 60,
    waktu_kerja INTEGER DEFAULT 120,
    gambar TEXT,
    dipakai INTEGER DEFAULT 0,
    cadangan INTEGER DEFAULT 0,
    ronde TEXT DEFAULT 'neraca',
    planet TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS tim (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    skor INTEGER DEFAULT 0,
    terkunci INTEGER DEFAULT 0,
    urutan INTEGER DEFAULT 0,
    aktif INTEGER DEFAULT 1,
    sudah_main INTEGER DEFAULT 0,
    peserta_neraca INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ronde INTEGER DEFAULT 1,
    soal_aktif_id INTEGER,
    timer_status TEXT DEFAULT 'STOPPED', -- 'STOPPED', 'RUNNING', 'PAUSED'
    timer_start_server_ts INTEGER,
    timer_elapsed_seconds REAL DEFAULT 0,
    waktu_tampil INTEGER DEFAULT 60,
    waktu_kerja INTEGER DEFAULT 120,
    poin_soal INTEGER DEFAULT 10,
    toleransi_global REAL DEFAULT 0.01,
    buzzer_terbuka INTEGER DEFAULT 0,
    buzzer_pemenang INTEGER,
    buzzer_timestamp INTEGER,
    jawaban_terakhir_tim INTEGER,
    jawaban_terakhir_nilai REAL,
    jawaban_terakhir_status TEXT, -- 'BENAR', 'SALAH', null
    jawaban_terakhir_selisih REAL,
    jawaban_terakhir_sudut REAL,
    tampilkan_kunci INTEGER DEFAULT 0,
    kunci_tim INTEGER DEFAULT 0,
    pin_host TEXT DEFAULT '1234',
    mode_ronde TEXT DEFAULT 'neraca', -- 'neraca' / 'planet'
    tim_giliran INTEGER DEFAULT NULL,
    planet_step INTEGER DEFAULT 1, -- 1: tampil_giliran, 2: tab_soal, 3: pilih_planet, 4: mic_soal, 5: selesai
    planet_terpilih TEXT DEFAULT NULL,
    soal_planet_id INTEGER DEFAULT NULL,
    poin_planet_tab INTEGER DEFAULT 20,
    poin_planet_mic INTEGER DEFAULT 30,
    waktu_planet_tab INTEGER DEFAULT 120,
    waktu_planet_mic INTEGER DEFAULT 60,
    mode_soal_dipakai_ulang INTEGER DEFAULT 0,
    hasil_planet_tab TEXT DEFAULT NULL,
    hasil_planet_mic TEXT DEFAULT NULL,
    papan_planet_terkunci_manual INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu TEXT NOT NULL,
    tim INTEGER,
    aksi TEXT NOT NULL,
    jawaban TEXT,
    hasil TEXT
  );

  CREATE TABLE IF NOT EXISTS giliran (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tim INTEGER NOT NULL,
    hasil_tab TEXT,
    planet TEXT,
    hasil_mic TEXT,
    poin_tab INTEGER DEFAULT 0,
    poin_mic INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe Migration for existing databases without losing data
function runSafeMigrations() {
  const soalCols = db.prepare("PRAGMA table_info(soal)").all().map(c => c.name);
  if (!soalCols.includes('ronde')) {
    db.exec("ALTER TABLE soal ADD COLUMN ronde TEXT DEFAULT 'neraca'");
  }
  if (!soalCols.includes('planet')) {
    db.exec("ALTER TABLE soal ADD COLUMN planet TEXT DEFAULT NULL");
  }
  db.exec("UPDATE soal SET ronde = 'neraca' WHERE ronde IS NULL OR ronde = ''");

  // Migration for tim table to support dynamic teams (id, urutan, aktif, sudah_main, peserta_neraca)
  const timCols = db.prepare("PRAGMA table_info(tim)").all().map(c => c.name);
  if (!timCols.includes('id')) {
    db.exec("CREATE TABLE tim_new (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, skor INTEGER DEFAULT 0, terkunci INTEGER DEFAULT 0, urutan INTEGER DEFAULT 0, aktif INTEGER DEFAULT 1, sudah_main INTEGER DEFAULT 0, peserta_neraca INTEGER DEFAULT 1);");
    db.exec("INSERT INTO tim_new (id, nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca) SELECT no, nama, skor, terkunci, no, 1, 0, 1 FROM tim;");
    db.exec("DROP TABLE tim;");
    db.exec("ALTER TABLE tim_new RENAME TO tim;");
  } else {
    if (!timCols.includes('urutan')) db.exec("ALTER TABLE tim ADD COLUMN urutan INTEGER DEFAULT 0;");
    if (!timCols.includes('aktif')) db.exec("ALTER TABLE tim ADD COLUMN aktif INTEGER DEFAULT 1;");
    if (!timCols.includes('sudah_main')) db.exec("ALTER TABLE tim ADD COLUMN sudah_main INTEGER DEFAULT 0;");
    if (!timCols.includes('peserta_neraca')) db.exec("ALTER TABLE tim ADD COLUMN peserta_neraca INTEGER DEFAULT 1;");
  }

  const stateCols = db.prepare("PRAGMA table_info(state)").all().map(c => c.name);
  const stateNewCols = [
    { name: 'mode_ronde', def: "TEXT DEFAULT 'neraca'" },
    { name: 'tim_giliran', def: "INTEGER DEFAULT NULL" },
    { name: 'planet_step', def: "INTEGER DEFAULT 1" },
    { name: 'planet_terpilih', def: "TEXT DEFAULT NULL" },
    { name: 'soal_planet_id', def: "INTEGER DEFAULT NULL" },
    { name: 'poin_planet_tab', def: "INTEGER DEFAULT 20" },
    { name: 'poin_planet_mic', def: "INTEGER DEFAULT 30" },
    { name: 'waktu_planet_tab', def: "INTEGER DEFAULT 120" },
    { name: 'waktu_planet_mic', def: "INTEGER DEFAULT 60" },
    { name: 'mode_soal_dipakai_ulang', def: "INTEGER DEFAULT 0" },
    { name: 'hasil_planet_tab', def: "TEXT DEFAULT NULL" },
    { name: 'hasil_planet_mic', def: "TEXT DEFAULT NULL" },
    { name: 'papan_planet_terkunci_manual', def: "INTEGER DEFAULT 0" }
  ];

  for (const col of stateNewCols) {
    if (!stateCols.includes(col.name)) {
      db.exec(`ALTER TABLE state ADD COLUMN ${col.name} ${col.def}`);
    }
  }
}
runSafeMigrations();

// Insert default state if missing
const stateRow = db.prepare('SELECT * FROM state WHERE id = 1').get();
if (!stateRow) {
  db.prepare(`
    INSERT INTO state (id, ronde, timer_status, waktu_tampil, waktu_kerja, poin_soal, toleransi_global, pin_host, mode_ronde, planet_step)
    VALUES (1, 1, 'STOPPED', 60, 120, 10, 0.01, '1234', 'neraca', 1)
  `).run();
}

// Insert default teams if missing
const teamCount = db.prepare('SELECT COUNT(*) as count FROM tim').get().count;
if (teamCount === 0) {
  const insertTeam = db.prepare('INSERT INTO tim (nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca) VALUES (?, 0, 0, ?, 1, 0, 1)');
  const defaultTeams = [
    'Tim Alfa (SMA 1)',
    'Tim Beta (SMA 2)',
    'Tim Gamma (SMA 3)',
    'Tim Delta (MAN 1)',
    'Tim Epsilon (SMA 4)'
  ];
  defaultTeams.forEach((nama, idx) => {
    insertTeam.run(nama, idx + 1);
  });
}

// Seed sample questions for Ronde Neraca if empty
const soalNeracaCount = db.prepare("SELECT COUNT(*) as count FROM soal WHERE ronde = 'neraca'").get().count;
if (soalNeracaCount === 0) {
  const insertSoal = db.prepare(`
    INSERT INTO soal (mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, gambar, dipakai, cadangan, ronde, planet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'neraca', NULL)
  `);

  const initialQuestions = [
    {
      mapel: 'Fisika',
      soal: 'Sebuah benda bermassa $2\\text{ kg}$ dilepaskan dari ketinggian $h = 20\\text{ m}$ tanpa kecepatan awal di atas permukaan tanah. Jika percepatan gravitasi $g = 9.8\\text{ m/s}^2$ dan gesekan udara diabaikan, hitung energi kinetik benda saat berada pada ketinggian $5\\text{ m}$ di atas tanah!',
      kunci: 294,
      satuan: 'Joule',
      toleransi: 0.5,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 0
    },
    {
      mapel: 'Matematika',
      soal: 'Tentukan jumlah seluruh bilangan bulat positif kelipatan 7 yang kurang dari 500 dan sekaligus habis dibagi oleh 3!',
      kunci: 5796,
      satuan: '',
      toleransi: 0,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 0
    },
    {
      mapel: 'Kimia',
      soal: 'Gas metana $(\\text{CH}_4)$ sebanyak $8\\text{ gram}$ dibakar sempurna dengan oksigen berlebih sesuai reaksi: $\\text{CH}_4 + 2\\text{O}_2 \\rightarrow \\text{CO}_2 + 2\\text{H}_2\\text{O}$. Berapakah volume gas $\\text{CO}_2$ yang dihasilkan jika diukur pada keadaan standar (STP) dalam liter? $(\\text{Ar: C}=12, \\text{H}=1)$',
      kunci: 11.2,
      satuan: 'liter',
      toleransi: 0.1,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 0
    },
    {
      mapel: 'Fisika',
      soal: 'Sebuah mesin Carnot bekerja di antara reservoir bersuhu tinggi $600\\text{ K}$ dan reservoir bersuhu rendah $360\\text{ K}$. Jika mesin menyerap kalor sebesar $1500\\text{ Joule}$ dari reservoir panas setiap siklus, berapakah usaha mekanik total yang dihasilkan mesin dalam satu siklus?',
      kunci: 600,
      satuan: 'Joule',
      toleransi: 1,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 0
    },
    {
      mapel: 'Matematika',
      soal: 'Pada sebuah bidang datar terdapat 12 titik yang posisinya sedemikian rupa sehingga tidak ada 3 titik yang segaris, kecuali 4 titik tertentu yang terletak pada sebuah garis lurus yang sama. Berapa banyak segitiga berbeda yang dapat dibentuk dari titik-titik tersebut?',
      kunci: 216,
      satuan: '',
      toleransi: 0,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 0
    },
    {
      mapel: 'Fisika',
      soal: '[CADANGAN] Kawat penghantar tembaga memiliki hambatan $25\\,\\Omega$ pada suhu $20^\\circ\\text{C}$. Jika koefisien suhu hambatan kawat adalah $\\alpha = 0.004\\,^\\circ\\text{C}^{-1}$, hitung hambatan kawat tersebut saat suhunya naik menjadi $80^\\circ\\text{C}$!',
      kunci: 31,
      satuan: 'ohm',
      toleransi: 0.1,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 1
    },
    {
      mapel: 'Kimia',
      soal: '[CADANGAN] Larutan asam kuat $\\text{HCl}$ dengan konsentrasi $0.005\\text{ M}$ diencerkan dengan air suling hingga volumenya menjadi 5 kali volume awal. Berapakah nilai pH larutan akhir setelah pengenceran tersebut?',
      kunci: 3.0,
      satuan: '',
      toleransi: 0.05,
      waktu_tampil: 60,
      waktu_kerja: 120,
      gambar: null,
      dipakai: 0,
      cadangan: 1
    }
  ];

  for (const q of initialQuestions) {
    insertSoal.run(
      q.mapel, q.soal, q.kunci, q.satuan, q.toleransi,
      q.waktu_tampil, q.waktu_kerja, q.gambar, q.dipakai, q.cadangan
    );
  }

  const first = db.prepare("SELECT id, waktu_tampil, waktu_kerja, toleransi FROM soal WHERE ronde = 'neraca' AND cadangan = 0 ORDER BY id ASC LIMIT 1").get();
  if (first) {
    db.prepare(`
      UPDATE state
      SET soal_aktif_id = ?, waktu_tampil = ?, waktu_kerja = ?, toleransi_global = ?
      WHERE id = 1
    `).run(first.id, first.waktu_tampil, first.waktu_kerja, first.toleransi);
  }
}

// Seed 8 Planets (2 questions each) + 2 TAB questions for Ronde 5: Misi Planet
function seedPlanetQuestions() {
  const count = db.prepare("SELECT COUNT(*) as count FROM soal WHERE ronde = 'planet'").get().count;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO soal (mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, dipakai, cadangan, ronde, planet)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'planet', ?)
  `);

  const planetData = [
    // 2 Soal Meja TAB (Umum Misi Antariksa)
    {
      mapel: 'Fisika',
      soal: '[MEJA TAB] Sebuah wahana antariksa bermassa $500\\text{ kg}$ bergerak dengan kecepatan $12\\text{ km/s}$. Berapakah energi kinetik wahana tersebut dalam satuan GigaJoule (GJ)? ($1\\text{ GJ} = 10^9\\text{ J}$)',
      kunci: 36,
      satuan: 'GJ',
      toleransi: 0.5,
      planet: null
    },
    {
      mapel: 'Fisika',
      soal: '[MEJA TAB] Teleskop antariksa mendeteksi transmisi radio dari wahana di dekat Jupiter pada jarak $600 \\times 10^6\\text{ km}$. Jika cepat rambat gelombang elektromagnetik $c = 3 \\times 10^5\\text{ km/s}$, berapa detik waktu tempuh sinyal tersebut sampai ke stasiun penerima di Bumi?',
      kunci: 2000,
      satuan: 'detik',
      toleransi: 10,
      planet: null
    },

    // 8 Planet x 2 Soal (Meja MIC)
    // 1. Merkurius
    {
      mapel: 'Astronomi',
      soal: 'Jarak perihelion Merkurius adalah $46 \\times 10^6\\text{ km}$ dan aphelionnya $70 \\times 10^6\\text{ km}$. Berapakah eksentrisitas orbit Merkurius? ($e = \\frac{r_a - r_p}{r_a + r_p}$)',
      kunci: 0.207,
      satuan: '',
      toleransi: 0.02,
      planet: 'Merkurius'
    },
    {
      mapel: 'Fisika',
      soal: 'Suhu permukaan Merkurius saat siang mencapai $430^\\circ\\text{C}$ dan pada malam hari $-180^\\circ\\text{C}$. Berapakah rentang variasi suhu ekstrem permukaan Merkurius dalam satuan Kelvin/Celsius?',
      kunci: 610,
      satuan: 'K',
      toleransi: 5,
      planet: 'Merkurius'
    },

    // 2. Venus
    {
      mapel: 'Fisika',
      soal: 'Tekanan atmosfer di permukaan Venus adalah 92 kali tekanan atmosfer Bumi ($1\\text{ atm} = 101.3\\text{ kPa}$). Hitung tekanan permukaan Venus dalam satuan bar! ($1\\text{ bar} = 100\\text{ kPa}$)',
      kunci: 93.2,
      satuan: 'bar',
      toleransi: 2,
      planet: 'Venus'
    },
    {
      mapel: 'Astronomi',
      soal: 'Periode rotasi retrograde Venus adalah 243 hari Bumi dan periode revolusi 225 hari Bumi. Panjang satu hari matahari (solar day) di Venus adalah sekitar berapa hari Bumi? (Gunakan $\\frac{1}{T_{solar}} = \\frac{1}{T_{rot}} + \\frac{1}{T_{rev}}$)',
      kunci: 117,
      satuan: 'hari',
      toleransi: 2,
      planet: 'Venus'
    },

    // 3. Bumi
    {
      mapel: 'Fisika',
      soal: 'Jika massa Bumi $M = 5.97 \\times 10^{24}\\text{ kg}$ dan jari-jari Bumi $R = 6371\\text{ km}$, hitung kecepatan lepas (escape velocity) dari permukaan Bumi dalam satuan km/s! ($G = 6.674 \\times 10^{-11}\\text{ N m}^2/\\text{kg}^2$)',
      kunci: 11.2,
      satuan: 'km/s',
      toleransi: 0.3,
      planet: 'Bumi'
    },
    {
      mapel: 'Fisika',
      soal: 'Stasiun Luar Angkasa Internasional (ISS) mengorbit pada ketinggian rata-rata $400\\text{ km}$ di atas permukaan Bumi ($R_B = 6371\\text{ km}, M_B = 5.97 \\times 10^{24}\\text{ kg}$). Berapakah kelajuan orbit ISS dalam satuan km/s?',
      kunci: 7.67,
      satuan: 'km/s',
      toleransi: 0.2,
      planet: 'Bumi'
    },

    // 4. Mars
    {
      mapel: 'Fisika',
      soal: 'Percepatan gravitasi permukaan Mars adalah $0.38\\,g$ Bumi ($g_B = 9.8\\text{ m/s}^2$). Jika seorang astronaut bermassa total $100\\text{ kg}$, berapakah berat astronaut tersebut saat berdiri di permukaan Mars dalam satuan Newton?',
      kunci: 372.4,
      satuan: 'Newton',
      toleransi: 5,
      planet: 'Mars'
    },
    {
      mapel: 'Astronomi',
      soal: 'Gunung Olympus Mons di Mars memiliki ketinggian $22\\text{ km}$. Jika Gunung Everest di Bumi berketinggian $8.848\\text{ km}$, berapa kali lipat Olympus Mons lebih tinggi dibandingkan Gunung Everest?',
      kunci: 2.49,
      satuan: 'kali',
      toleransi: 0.1,
      planet: 'Mars'
    },

    // 5. Jupiter
    {
      mapel: 'Astronomi',
      soal: 'Massa planet Jupiter adalah $1.90 \\times 10^{27}\\text{ kg}$. Berapa kali lipat massa Jupiter dibandingkan massa Bumi ($M_B = 5.97 \\times 10^{24}\\text{ kg}$)? Bulatkan ke bilangan bulat terdekat.',
      kunci: 318,
      satuan: 'kali',
      toleransi: 3,
      planet: 'Jupiter'
    },
    {
      mapel: 'Astronomi',
      soal: 'Satelit Ganymede memiliki diameter $5268\\text{ km}$, sedangkan planet Merkurius berdiameter $4879\\text{ km}$. Berapa persen rasio diameter Ganymede terhadap diameter Merkurius? ($\\frac{d_{Gan}}{d_{Mer}} \\times 100\\%$)',
      kunci: 108,
      satuan: '%',
      toleransi: 2,
      planet: 'Jupiter'
    },

    // 6. Saturnus
    {
      mapel: 'Fisika',
      soal: 'Saturnus memiliki massa $5.68 \\times 10^{26}\\text{ kg}$ dan volume $8.27 \\times 10^{14}\\text{ km}^3$. Hitung kerapatan rata-rata (density) planet Saturnus dalam satuan $\\text{kg/m}^3$!',
      kunci: 687,
      satuan: 'kg/m^3',
      toleransi: 15,
      planet: 'Saturnus'
    },
    {
      mapel: 'Astronomi',
      soal: 'Cincin utama Saturnus membentang hingga radius $140000\\text{ km}$ dari pusat planet. Jika jari-jari ekuator Saturnus adalah $60268\\text{ km}$, berapakah lebar rentang cincin dari permukaan atmosfer ke tepi luar dalam ribuan km?',
      kunci: 79.7,
      satuan: 'ribu km',
      toleransi: 2,
      planet: 'Saturnus'
    },

    // 7. Uranus
    {
      mapel: 'Astronomi',
      soal: 'Kemiringan sumbu rotasi (axial tilt) planet Uranus adalah $97.8^\\circ$ terhadap bidang orbit. Berapa derajat deviasi kemiringan ini dari sudut tegak lurus sempurna ($90^\\circ$)?',
      kunci: 7.8,
      satuan: 'derajat',
      toleransi: 0.2,
      planet: 'Uranus'
    },
    {
      mapel: 'Astronomi',
      soal: 'Periode revolusi Uranus mengelilingi Matahari adalah 84 tahun Bumi. Berdasarkan Hukum III Kepler ($T^2 = a^3$), berapakah jarak rata-rata sumbu semi-mayor orbit Uranus dalam Satuan Astronomi (AU)?',
      kunci: 19.2,
      satuan: 'AU',
      toleransi: 0.4,
      planet: 'Uranus'
    },

    // 8. Neptunus
    {
      mapel: 'Fisika',
      soal: 'Kecepatan badai angin di atmosfer Neptunus tercatat mencapai $2160\\text{ km/jam}$. Berapakah kecepatan angin tercepat Tata Surya tersebut dalam satuan meter per detik (m/s)?',
      kunci: 600,
      satuan: 'm/s',
      toleransi: 10,
      planet: 'Neptunus'
    },
    {
      mapel: 'Fisika',
      soal: 'Suhu permukaan satelit Triton di Neptunus tercatat sekitar $-235^\\circ\\text{C}$. Berapakah suhu terdingin di Tata Surya tersebut dalam skala mutlak Kelvin?',
      kunci: 38.15,
      satuan: 'K',
      toleransi: 1,
      planet: 'Neptunus'
    }
  ];

  for (const q of planetData) {
    insert.run(q.mapel, q.soal, q.kunci, q.satuan, q.toleransi, 60, 60, q.planet);
  }
}
seedPlanetQuestions();

// Helper: Add log
function addLog(tim, aksi, jawaban = '', hasil = '') {
  const waktu = new Date().toISOString().replace('T', ' ').substring(0, 19);
  db.prepare('INSERT INTO log (waktu, tim, aksi, jawaban, hasil) VALUES (?, ?, ?, ?, ?)').run(
    waktu, tim, aksi, String(jawaban || ''), String(hasil || '')
  );
}

// --------------------------------------------------------------------------
// STATE BUILDER WITH STRICT SECURITY FILTERING
// --------------------------------------------------------------------------
function getFullState(isHost = false) {
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const teams = db.prepare('SELECT id, id AS no, nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca FROM tim ORDER BY urutan ASC, id ASC').all();

  let activeQuestion = null;
  if (state.soal_aktif_id) {
    activeQuestion = db.prepare('SELECT * FROM soal WHERE id = ?').get(state.soal_aktif_id);
  }

  let soalPlanet = null;
  if (state.soal_planet_id) {
    soalPlanet = db.prepare('SELECT * FROM soal WHERE id = ?').get(state.soal_planet_id);
  }

  // Get used planets in current competition
  const usedPlanets = db.prepare('SELECT DISTINCT planet FROM giliran WHERE planet IS NOT NULL').all().map(r => r.planet);
  if (state.planet_terpilih && !usedPlanets.includes(state.planet_terpilih)) {
    usedPlanets.push(state.planet_terpilih);
  }

  // Compute live elapsed & remaining timer
  let currentElapsed = state.timer_elapsed_seconds || 0;
  if (state.timer_status === 'RUNNING' && state.timer_start_server_ts) {
    const diff = (Date.now() - state.timer_start_server_ts) / 1000;
    currentElapsed += Math.max(0, diff);
  }

  const waktuKerja = state.waktu_kerja || 120;
  const sisaWaktu = Math.max(0, waktuKerja - currentElapsed);
  const soalTersembunyi = currentElapsed >= (state.waktu_tampil || 60);

  // SANITIZATION FOR CLIENT SECURITY:
  // Non-host clients (Display & Tablet) MUST NOT receive keys, tolerances, or PINs.
  const statePayload = { ...state };
  let sanitizedActiveQ = activeQuestion ? { ...activeQuestion } : null;
  let sanitizedPlanetQ = soalPlanet ? { ...soalPlanet } : null;

  if (!isHost) {
    delete statePayload.pin_host;
    statePayload.tampilkan_kunci = 0; // Display never receives flag to render key

    if (sanitizedActiveQ) {
      delete sanitizedActiveQ.kunci;
      delete sanitizedActiveQ.toleransi;
    }
    if (sanitizedPlanetQ) {
      delete sanitizedPlanetQ.kunci;
      delete sanitizedPlanetQ.toleransi;
    }
  }

  return {
    state: {
      ...statePayload,
      current_elapsed_seconds: currentElapsed,
      sisa_waktu: Math.ceil(sisaWaktu),
      soal_tersembunyi: soalTersembunyi,
      server_time: Date.now()
    },
    teams,
    activeQuestion: sanitizedActiveQ,
    soalPlanet: sanitizedPlanetQ,
    usedPlanets,
    recentGiliran: db.prepare('SELECT * FROM giliran ORDER BY id DESC LIMIT 10').all()
  };
}

// --------------------------------------------------------------------------
// WEBSOCKET BROADCASTING & REAL-TIME ENGINE
// --------------------------------------------------------------------------
function broadcastState(eventType = 'STATE_UPDATE', extra = {}) {
  const publicData = getFullState(false);
  const hostData = getFullState(true);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const isClientHost = Boolean(client.isHost);
      const dataToSend = isClientHost ? hostData : publicData;
      const extraToSend = { ...extra };

      if (!isClientHost) {
        delete extraToSend.kunci;
        delete extraToSend.toleransi;
        // In reuse mode (mode_soal_dipakai_ulang), hide selisih for wrong answers from public display
        if (publicData.state.mode_soal_dipakai_ulang && extraToSend.status === 'SALAH') {
          delete extraToSend.selisih;
        }
      }

      client.send(JSON.stringify({
        type: eventType,
        data: dataToSend,
        ...extraToSend
      }));
    }
  });
}

// Timer Ticker Loop (Every 500ms)
setInterval(() => {
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  if (state && state.timer_status === 'RUNNING') {
    const now = Date.now();
    const currentRun = (now - state.timer_start_server_ts) / 1000;
    const totalElapsed = (state.timer_elapsed_seconds || 0) + currentRun;
    const waktuKerja = state.waktu_kerja || 120;

    if (totalElapsed >= waktuKerja) {
      // Time is up!
      if (state.mode_ronde === 'planet') {
        if (state.planet_step === 2) {
          // Meja TAB timed out -> auto SALAH, locks planet board
          db.prepare(`
            UPDATE state
            SET timer_status = 'STOPPED',
                timer_elapsed_seconds = ?,
                hasil_planet_tab = 'SALAH',
                planet_step = 3
            WHERE id = 1
          `).run(waktuKerja);

          db.prepare(`
            INSERT INTO giliran (tim, hasil_tab, planet, hasil_mic, poin_tab, poin_mic)
            VALUES (?, 'SALAH', NULL, NULL, 0, 0)
          `).run(state.tim_giliran || 1);

          addLog(state.tim_giliran, 'PLANET_TAB_TIMEOUT', '', 'Waktu Meja TAB habis (SALAH) - Papan Planet Terkunci');
          broadcastState('PLANET_TAB_RESULT', { status: 'SALAH', timeout: true });
        } else if (state.planet_step === 4) {
          // Meja MIC timed out
          db.prepare(`
            UPDATE state
            SET timer_status = 'STOPPED',
                timer_elapsed_seconds = ?
            WHERE id = 1
          `).run(waktuKerja);

          addLog(state.tim_giliran, 'PLANET_MIC_TIMEOUT', '', 'Waktu Meja MIC habis');
          broadcastState('PLANET_MIC_TIMEOUT');
        }
      } else {
        // Ronde Neraca
        db.prepare(`
          UPDATE state
          SET timer_status = 'STOPPED',
              timer_elapsed_seconds = ?,
              buzzer_terbuka = 0,
              tampilkan_kunci = 0
        WHERE id = 1
        `).run(waktuKerja);

        addLog(null, 'WAKTU_HABIS', '', 'Timer selesai - Waktu pengerjaan habis');
        broadcastState('TIMER_EXPIRED');
      }
    } else {
      broadcastState('TICK');
    }
  }
}, 500);

// WebSocket Connection Management
wss.on('connection', (ws) => {
  ws.isHost = false;

  // Initial send is strictly public/sanitized
  ws.send(JSON.stringify({
    type: 'INIT_STATE',
    data: getFullState(false)
  }));

  ws.on('message', (messageText) => {
    try {
      const msg = JSON.parse(messageText);
      handleWsMessage(ws, msg);
    } catch (err) {
      console.error('WS Parse Error:', err.message);
    }
  });
});

// WS Message Handling
function handleWsMessage(ws, msg) {
  const type = msg.type;
  const payload = msg.payload || {};

  switch (type) {
    case 'AUTH_HOST': {
      const state = db.prepare('SELECT pin_host FROM state WHERE id = 1').get();
      if (payload.pin === state.pin_host) {
        ws.isHost = true;
        ws.send(JSON.stringify({
          type: 'INIT_STATE',
          data: getFullState(true)
        }));
      }
      break;
    }

    case 'BUZZER_PRESS': {
      // Tablet touched by Team in Ronde Neraca
      const teamNo = parseInt(payload.team, 10);
      const state = db.prepare('SELECT * FROM state WHERE id = 1').get();

      if (state.mode_ronde !== 'neraca' || !state.buzzer_terbuka) {
        ws.send(JSON.stringify({ type: 'BUZZER_REJECTED', reason: 'Buzzer sedang terkunci!' }));
        return;
      }

      const team = db.prepare('SELECT * FROM tim WHERE id = ?').get(teamNo);
      if (!team || !team.aktif || !team.peserta_neraca) {
        ws.send(JSON.stringify({ type: 'BUZZER_REJECTED', reason: 'Tim bukan peserta aktif ronde ini!' }));
        return;
      }
      if (team.terkunci) {
        ws.send(JSON.stringify({ type: 'BUZZER_REJECTED', reason: 'Tim Anda sedang terkunci untuk soal ini!' }));
        return;
      }

      const now = Date.now();
      db.prepare(`
        UPDATE state
        SET buzzer_terbuka = 0,
            buzzer_pemenang = ?,
            buzzer_timestamp = ?
        WHERE id = 1
      `).run(teamNo, now);

      addLog(teamNo, 'BUZZER_MENANG', '', `Tim ${teamNo} (${team.nama}) menekan buzzer pertama`);

      broadcastState('BUZZER_WIN', {
        pemenang_no: teamNo,
        pemenang_nama: team.nama,
        timestamp: now
      });
      break;
    }

    case 'TIMBANG_SUBMIT': {
      // Team submitted answer in Ronde Neraca
      const teamNo = parseInt(payload.team, 10);
      const jawaban = parseFloat(payload.jawaban);

      if (isNaN(jawaban)) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Jawaban harus berupa angka!' }));
        return;
      }

      const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
      if (!state.soal_aktif_id) return;

      const soal = db.prepare('SELECT * FROM soal WHERE id = ?').get(state.soal_aktif_id);
      if (!soal) return;

      const kunci = soal.kunci;
      const toleransi = (soal.toleransi !== null && soal.toleransi !== undefined) ? soal.toleransi : state.toleransi_global;
      const selisih = jawaban - kunci;
      const absSelisih = Math.abs(selisih);

      let status = 'SALAH';
      let sudut = 0;

      if (absSelisih <= toleransi) {
        status = 'BENAR';
        sudut = 0;
        const poin = state.poin_soal || 10;
        db.prepare('UPDATE tim SET skor = skor + ? WHERE id = ?').run(poin, teamNo);

        db.prepare(`
          UPDATE state
          SET buzzer_terbuka = 0,
              jawaban_terakhir_tim = ?,
              jawaban_terakhir_nilai = ?,
              jawaban_terakhir_status = 'BENAR',
              jawaban_terakhir_selisih = ?,
              jawaban_terakhir_sudut = 0,
              tampilkan_kunci = 0,
              timer_status = 'PAUSED'
          WHERE id = 1
        `).run(teamNo, jawaban, selisih);

        addLog(teamNo, 'JAWABAN_BENAR', jawaban, `Benar! Selisih ${selisih.toFixed(4)}. Poin +${poin}`);

        broadcastState('TIMBANG_RESULT', {
          tim: teamNo,
          jawaban,
          status: 'BENAR',
          selisih,
          sudut: 0,
          poin_didapat: poin
        });
      } else {
        status = 'SALAH';

        // Check Mode Soal Dipakai Ulang: if active, use fixed angle without leaking direction
        if (state.mode_soal_dipakai_ulang) {
          sudut = 12; // Fixed neutral tilt, does not indicate higher or lower
        } else {
          const refRange = Math.max(Math.abs(kunci) * 0.4, 10);
          let calculatedAngle = (selisih / refRange) * 16;
          if (calculatedAngle > 20) calculatedAngle = 20;
          if (calculatedAngle < -20) calculatedAngle = -20;
          if (calculatedAngle > 0 && calculatedAngle < 4) calculatedAngle = 4;
          if (calculatedAngle < 0 && calculatedAngle > -4) calculatedAngle = -4;
          sudut = parseFloat(calculatedAngle.toFixed(2));
        }

        db.prepare('UPDATE tim SET terkunci = 1 WHERE id = ?').run(teamNo);

        const currentElapsed = (state.timer_status === 'RUNNING' && state.timer_start_server_ts)
          ? (state.timer_elapsed_seconds || 0) + (Date.now() - state.timer_start_server_ts) / 1000
          : (state.timer_elapsed_seconds || 0);
        const sisaWaktu = Math.max(0, (state.waktu_kerja || 120) - currentElapsed);

        const unlockedRemaining = db.prepare('SELECT COUNT(*) as count FROM tim WHERE aktif = 1 AND peserta_neraca = 1 AND terkunci = 0').get().count;
        const reOpenBuzzer = (sisaWaktu > 0 && unlockedRemaining > 0) ? 1 : 0;

        db.prepare(`
          UPDATE state
          SET buzzer_terbuka = ?,
              buzzer_pemenang = NULL,
              jawaban_terakhir_tim = ?,
              jawaban_terakhir_nilai = ?,
              jawaban_terakhir_status = 'SALAH',
              jawaban_terakhir_selisih = ?,
              jawaban_terakhir_sudut = ?
          WHERE id = 1
        `).run(reOpenBuzzer, teamNo, jawaban, selisih, sudut);

        addLog(teamNo, 'JAWABAN_SALAH', jawaban, `Salah! Selisih ${selisih.toFixed(4)}. Tim ${teamNo} dikunci untuk soal ini.`);

        broadcastState('TIMBANG_RESULT', {
          tim: teamNo,
          jawaban,
          status: 'SALAH',
          selisih,
          sudut,
          reOpenBuzzer: Boolean(reOpenBuzzer)
        });
      }
      break;
    }

    case 'PLANET_TAB_SUBMIT': {
      // Meja TAB in Ronde 5: Misi Planet
      handlePlanetTabSubmit(payload.team, payload.jawaban, ws);
      break;
    }

    default:
      break;
  }
}

// --------------------------------------------------------------------------
// PLANET MODE TAB SUBMISSION LOGIC (AUTOMATED EVALUATION)
// --------------------------------------------------------------------------
function handlePlanetTabSubmit(teamNoInput, jawabanInput, ws = null) {
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();

  if (state.mode_ronde !== 'planet' || state.planet_step !== 2) {
    if (ws) ws.send(JSON.stringify({ type: 'ERROR', message: 'Bukan saatnya menjawab soal Meja TAB!' }));
    return { success: false, message: 'Step tidak sesuai' };
  }

  const teamNo = parseInt(teamNoInput || state.tim_giliran, 10);
  if (state.tim_giliran && teamNo !== state.tim_giliran) {
    if (ws) ws.send(JSON.stringify({ type: 'ERROR', message: 'Bukan giliran tim Anda!' }));
    return { success: false, message: 'Bukan giliran tim' };
  }

  const jawaban = parseFloat(jawabanInput);
  if (isNaN(jawaban)) {
    if (ws) ws.send(JSON.stringify({ type: 'ERROR', message: 'Jawaban harus berupa angka!' }));
    return { success: false, message: 'Harus angka' };
  }

  // Prevent resubmission
  if (state.hasil_planet_tab) {
    if (ws) ws.send(JSON.stringify({ type: 'ERROR', message: 'Jawaban sudah pernah dikirim!' }));
    return { success: false, message: 'Sudah submit' };
  }

  // Get active TAB question
  let soal = null;
  if (state.soal_aktif_id) {
    soal = db.prepare('SELECT * FROM soal WHERE id = ?').get(state.soal_aktif_id);
  }
  if (!soal) {
    soal = db.prepare("SELECT * FROM soal WHERE ronde = 'planet' AND planet IS NULL LIMIT 1").get();
  }
  if (!soal) {
    soal = db.prepare('SELECT * FROM soal LIMIT 1').get();
  }

  const kunci = soal.kunci;
  const toleransi = (soal.toleransi !== null && soal.toleransi !== undefined) ? soal.toleransi : 0.01;
  const absSelisih = Math.abs(jawaban - kunci);
  const isBenar = absSelisih <= toleransi;
  const poinTab = state.poin_planet_tab || 20;

  if (isBenar) {
    // Correct! +20 points, opens solar system board
    db.prepare('UPDATE tim SET skor = skor + ? WHERE id = ?').run(poinTab, teamNo);
    db.prepare(`
      UPDATE state
      SET hasil_planet_tab = 'BENAR',
          planet_step = 3,
          timer_status = 'PAUSED'
      WHERE id = 1
    `).run();

    addLog(teamNo, 'PLANET_TAB_BENAR', jawaban, `Meja TAB Benar (+${poinTab} poin). Papan Tata Surya Terbuka.`);

    broadcastState('PLANET_TAB_RESULT', {
      status: 'BENAR',
      tim: teamNo,
      jawaban,
      poin: poinTab
    });
    return { success: true, status: 'BENAR' };
  } else {
    // Wrong! Locks solar system board, turn ends
    db.prepare('UPDATE tim SET sudah_main = 1 WHERE id = ?').run(teamNo);
    db.prepare(`
      UPDATE state
      SET hasil_planet_tab = 'SALAH',
          planet_step = 3,
          timer_status = 'STOPPED'
      WHERE id = 1
    `).run();

    db.prepare(`
      INSERT INTO giliran (tim, hasil_tab, planet, hasil_mic, poin_tab, poin_mic)
      VALUES (?, 'SALAH', NULL, NULL, 0, 0)
    `).run(teamNo);

    addLog(teamNo, 'PLANET_TAB_SALAH', jawaban, 'Meja TAB Salah. Papan Tata Surya Terkunci.');

    broadcastState('PLANET_TAB_RESULT', {
      status: 'SALAH',
      tim: teamNo,
      jawaban,
      poin: 0
    });
    return { success: true, status: 'SALAH' };
  }
}

// --------------------------------------------------------------------------
// REST API FOR HOST & CONTROLS
// --------------------------------------------------------------------------

// Middleware: Verify Host PIN
function verifyPinMiddleware(req, res, next) {
  const pin = req.headers['x-host-pin'] || req.body.pin || req.query.pin;
  const state = db.prepare('SELECT pin_host FROM state WHERE id = 1').get();
  if (pin && pin === state.pin_host) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'PIN Juri salah atau tidak valid!' });
}

// Verify PIN endpoint
app.post('/api/host/verify-pin', (req, res) => {
  const { pin } = req.body;
  const state = db.prepare('SELECT pin_host FROM state WHERE id = 1').get();
  if (pin === state.pin_host) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'PIN Juri salah!' });
  }
});

// Get state: returns full state ONLY if valid host PIN is supplied
app.get('/api/state', (req, res) => {
  const pin = req.headers['x-host-pin'] || req.query.pin;
  const state = db.prepare('SELECT pin_host FROM state WHERE id = 1').get();
  const isHost = Boolean(pin && pin === state.pin_host);
  res.json(getFullState(isHost));
});

// Timer Controls (Start / Pause / Resume / Reset / Adjust)
app.post('/api/host/timer', verifyPinMiddleware, (req, res) => {
  const { action, sisa_waktu, adjustment } = req.body;
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const now = Date.now();

  if (action === 'START') {
    db.prepare(`
      UPDATE state
      SET timer_status = 'RUNNING',
          timer_start_server_ts = ?,
          timer_elapsed_seconds = 0,
          buzzer_terbuka = 1,
          tampilkan_kunci = 0
      WHERE id = 1
    `).run(now);
    addLog(null, 'TIMER_START', '', 'Timer dimulai');
  } else if (action === 'PAUSE') {
    if (state.timer_status === 'RUNNING') {
      const runSec = (now - state.timer_start_server_ts) / 1000;
      const totalElapsed = (state.timer_elapsed_seconds || 0) + runSec;
      db.prepare(`
        UPDATE state
        SET timer_status = 'PAUSED',
            timer_elapsed_seconds = ?,
            timer_start_server_ts = NULL
        WHERE id = 1
      `).run(totalElapsed);
      addLog(null, 'TIMER_PAUSE', '', `Timer dijeda pada detik ke-${Math.round(totalElapsed)}`);
    }
  } else if (action === 'RESUME') {
    if (state.timer_status === 'PAUSED' || state.timer_status === 'STOPPED') {
      db.prepare(`
        UPDATE state
        SET timer_status = 'RUNNING',
            timer_start_server_ts = ?
        WHERE id = 1
      `).run(now);
      addLog(null, 'TIMER_RESUME', '', 'Timer dilanjutkan');
    }
  } else if (action === 'RESET') {
    db.prepare(`
      UPDATE state
      SET timer_status = 'STOPPED',
          timer_start_server_ts = NULL,
          timer_elapsed_seconds = 0,
          buzzer_terbuka = 0,
          buzzer_pemenang = NULL,
          tampilkan_kunci = 0
      WHERE id = 1
    `).run();
    addLog(null, 'TIMER_RESET', '', 'Timer di-reset ke 0');
  } else if (action === 'ADJUST') {
    let currentElapsed = state.timer_elapsed_seconds || 0;
    if (state.timer_status === 'RUNNING' && state.timer_start_server_ts) {
      currentElapsed += (now - state.timer_start_server_ts) / 1000;
    }

    if (adjustment !== undefined) {
      currentElapsed = Math.max(0, currentElapsed - adjustment);
    } else if (sisa_waktu !== undefined) {
      currentElapsed = Math.max(0, (state.waktu_kerja || 120) - parseFloat(sisa_waktu));
    }

    db.prepare(`
      UPDATE state
      SET timer_elapsed_seconds = ?,
          timer_start_server_ts = ?
      WHERE id = 1
    `).run(currentElapsed, state.timer_status === 'RUNNING' ? now : null);
    addLog(null, 'TIMER_ADJUST', '', `Timer disesuaikan`);
  }

  broadcastState('TIMER_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Buzzer Controls (Ronde Neraca)
app.post('/api/host/buzzer', verifyPinMiddleware, (req, res) => {
  const { action, team } = req.body;
  const now = Date.now();

  if (action === 'OPEN') {
    db.prepare(`
      UPDATE state
      SET buzzer_terbuka = 1,
          buzzer_pemenang = NULL
      WHERE id = 1
    `).run();
    addLog(null, 'BUZZER_BUKA', '', 'Buzzer dibuka oleh juri');
    broadcastState('BUZZER_OPEN');
  } else if (action === 'LOCK') {
    db.prepare('UPDATE state SET buzzer_terbuka = 0 WHERE id = 1').run();
    addLog(null, 'BUZZER_KUNCI', '', 'Buzzer dikunci oleh juri');
    broadcastState('BUZZER_LOCK');
  } else if (action === 'SELECT_MANUAL') {
    const teamNo = parseInt(team, 10);
    const t = db.prepare('SELECT nama FROM tim WHERE id = ?').get(teamNo);
    if (!t) return res.status(400).json({ success: false, message: 'Tim tidak ditemukan' });

    db.prepare(`
      UPDATE state
      SET buzzer_terbuka = 0,
          buzzer_pemenang = ?,
          buzzer_timestamp = ?
      WHERE id = 1
    `).run(teamNo, now);

    addLog(teamNo, 'BUZZER_MANUAL', '', `Juri memilih Tim ${teamNo} (${t.nama}) sebagai pemenang buzzer manual`);
    broadcastState('BUZZER_WIN', {
      pemenang_no: teamNo,
      pemenang_nama: t.nama,
      timestamp: now,
      manual: true
    });
  }

  res.json({ success: true, state: getFullState(true) });
});

// Set Active Question / Next Question / Reset Question
app.post('/api/host/question/set-active', verifyPinMiddleware, (req, res) => {
  const { id } = req.body;
  const q = db.prepare('SELECT * FROM soal WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ success: false, message: 'Soal tidak ditemukan' });

  db.prepare('UPDATE tim SET terkunci = 0').run();
  db.prepare('UPDATE soal SET dipakai = 1 WHERE id = ?').run(id);

  db.prepare(`
    UPDATE state
    SET soal_aktif_id = ?,
        waktu_tampil = ?,
        waktu_kerja = ?,
        toleransi_global = ?,
        timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL,
        buzzer_terbuka = 0,
        buzzer_pemenang = NULL,
        jawaban_terakhir_tim = NULL,
        jawaban_terakhir_nilai = NULL,
        jawaban_terakhir_status = NULL,
        jawaban_terakhir_selisih = NULL,
        jawaban_terakhir_sudut = 0,
        tampilkan_kunci = 0
    WHERE id = 1
  `).run(q.id, q.waktu_tampil, q.waktu_kerja, q.toleransi);

  addLog(null, 'GANTI_SOAL', '', `Soal aktif diubah ke ID #${q.id} (${q.mapel})`);
  broadcastState('QUESTION_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Switch to Backup Question
app.post('/api/host/question/ganti-cadangan', verifyPinMiddleware, (req, res) => {
  let cadangan = db.prepare("SELECT * FROM soal WHERE ronde = 'neraca' AND cadangan = 1 AND dipakai = 0 ORDER BY id ASC LIMIT 1").get();
  if (!cadangan) {
    cadangan = db.prepare("SELECT * FROM soal WHERE ronde = 'neraca' AND cadangan = 1 ORDER BY id ASC LIMIT 1").get();
  }

  if (!cadangan) {
    return res.status(400).json({ success: false, message: 'Tidak ada soal cadangan yang tersedia!' });
  }

  db.prepare('UPDATE tim SET terkunci = 0').run();
  db.prepare('UPDATE soal SET dipakai = 1 WHERE id = ?').run(cadangan.id);

  db.prepare(`
    UPDATE state
    SET soal_aktif_id = ?,
        waktu_tampil = ?,
        waktu_kerja = ?,
        toleransi_global = ?,
        timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL,
        buzzer_terbuka = 0,
        buzzer_pemenang = NULL,
        jawaban_terakhir_tim = NULL,
        jawaban_terakhir_nilai = NULL,
        jawaban_terakhir_status = NULL,
        jawaban_terakhir_selisih = NULL,
        jawaban_terakhir_sudut = 0,
        tampilkan_kunci = 0
    WHERE id = 1
  `).run(cadangan.id, cadangan.waktu_tampil, cadangan.waktu_kerja, cadangan.toleransi);

  addLog(null, 'GANTI_SOAL_CADANGAN', '', `Diganti ke soal cadangan ID #${cadangan.id} (${cadangan.mapel})`);
  broadcastState('QUESTION_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Reset Active Question State
app.post('/api/host/question/reset', verifyPinMiddleware, (req, res) => {
  db.prepare('UPDATE tim SET terkunci = 0').run();
  db.prepare(`
    UPDATE state
    SET timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL,
        buzzer_terbuka = 0,
        buzzer_pemenang = NULL,
        jawaban_terakhir_tim = NULL,
        jawaban_terakhir_nilai = NULL,
        jawaban_terakhir_status = NULL,
        jawaban_terakhir_selisih = NULL,
        jawaban_terakhir_sudut = 0,
        tampilkan_kunci = 0
    WHERE id = 1
  `).run();

  addLog(null, 'RESET_SOAL', '', 'State soal aktif di-reset');
  broadcastState('QUESTION_RESET');
  res.json({ success: true, state: getFullState(true) });
});

// --------------------------------------------------------------------------
// RONDE 5: MISI PLANET REST ENDPOINTS
// --------------------------------------------------------------------------

// Switch Mode (Neraca / Planet)
app.post('/api/host/planet/set-mode', verifyPinMiddleware, (req, res) => {
  const { mode } = req.body;
  const modeVal = mode === 'planet' ? 'planet' : 'neraca';

  db.prepare(`
    UPDATE state
    SET mode_ronde = ?,
        timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL
    WHERE id = 1
  `).run(modeVal);

  addLog(null, 'MODE_RONDE_CHANGE', modeVal, `Mode ronde diubah ke ${modeVal.toUpperCase()}`);
  broadcastState('MODE_RONDE_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Set Tim Giliran
app.post('/api/host/planet/tim-giliran', verifyPinMiddleware, (req, res) => {
  const { team } = req.body;
  const teamNo = parseInt(team, 10);
  const t = db.prepare('SELECT nama FROM tim WHERE id = ?').get(teamNo);
  if (!t) return res.status(404).json({ success: false, message: 'Tim tidak ditemukan' });

  // Prepare a default TAB question if none set
  let tabQ = db.prepare("SELECT * FROM soal WHERE ronde = 'planet' AND planet IS NULL AND dipakai = 0 ORDER BY id ASC LIMIT 1").get();
  if (!tabQ) {
    tabQ = db.prepare("SELECT * FROM soal WHERE ronde = 'planet' AND planet IS NULL ORDER BY id ASC LIMIT 1").get();
  }

  const waktuTab = 120;
  db.prepare(`
    UPDATE state
    SET tim_giliran = ?,
        planet_step = 1,
        hasil_planet_tab = NULL,
        hasil_planet_mic = NULL,
        planet_terpilih = NULL,
        soal_planet_id = NULL,
        soal_aktif_id = ?,
        waktu_kerja = ?,
        timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL,
        papan_planet_terkunci_manual = 0
    WHERE id = 1
  `).run(teamNo, tabQ ? tabQ.id : null, waktuTab);

  addLog(teamNo, 'PLANET_GILIRAN_TIM', '', `Giliran Tim ${teamNo} (${t.nama}) pada Misi Planet`);
  broadcastState('PLANET_STEP_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Start Step 2: Meja TAB
app.post('/api/host/planet/start-tab', verifyPinMiddleware, (req, res) => {
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const now = Date.now();
  const waktuTab = state.waktu_planet_tab || 120;

  db.prepare(`
    UPDATE state
    SET planet_step = 2,
        waktu_kerja = ?,
        timer_status = 'RUNNING',
        timer_start_server_ts = ?,
        timer_elapsed_seconds = 0,
        hasil_planet_tab = NULL
    WHERE id = 1
  `).run(waktuTab, now);

  addLog(state.tim_giliran, 'PLANET_START_TAB', '', `Soal Meja TAB dimulai (Timer ${waktuTab}s)`);
  broadcastState('PLANET_STEP_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Meja TAB Answer Submit (REST fallback)
app.post('/api/planet/tab-submit', (req, res) => {
  const { team, jawaban } = req.body;
  const result = handlePlanetTabSubmit(team, jawaban);
  if (result.success) {
    res.json({ success: true, status: result.status });
  } else {
    res.status(400).json({ success: false, message: result.message });
  }
});

// Override Step 2 TAB Result
app.post('/api/host/planet/override-tab', verifyPinMiddleware, (req, res) => {
  const { hasil } = req.body;
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const teamNo = state.tim_giliran || 1;
  const poinTab = state.poin_planet_tab || 20;

  if (hasil === 'BENAR') {
    db.prepare('UPDATE tim SET skor = skor + ? WHERE id = ?').run(poinTab, teamNo);
    db.prepare(`
      UPDATE state
      SET hasil_planet_tab = 'BENAR',
          planet_step = 3,
          timer_status = 'PAUSED'
      WHERE id = 1
    `).run();
    addLog(teamNo, 'OVERRIDE_TAB_BENAR', '', `Juri meng-override Meja TAB menjadi BENAR (+${poinTab})`);
  } else {
    db.prepare(`
      UPDATE state
      SET hasil_planet_tab = 'SALAH',
          planet_step = 3,
          timer_status = 'STOPPED'
      WHERE id = 1
    `).run();
    addLog(teamNo, 'OVERRIDE_TAB_SALAH', '', 'Juri meng-override Meja TAB menjadi SALAH');
  }

  broadcastState('PLANET_TAB_RESULT', { status: hasil, tim: teamNo });
  res.json({ success: true, state: getFullState(true) });
});

// Step 3: Meja MIC selects a Planet
app.post('/api/host/planet/pilih-planet', verifyPinMiddleware, (req, res) => {
  const { planet } = req.body;
  if (!planet) return res.status(400).json({ success: false, message: 'Planet harus dipilih' });

  // Check if planet was already chosen
  const isUsed = db.prepare('SELECT COUNT(*) as count FROM giliran WHERE planet = ?').get(planet).count;
  if (isUsed > 0) {
    return res.status(400).json({ success: false, message: `Planet ${planet} sudah pernah dipilih tim lain!` });
  }

  // Find random unused question for this planet
  let q = db.prepare("SELECT * FROM soal WHERE ronde = 'planet' AND planet = ? AND dipakai = 0 ORDER BY RANDOM() LIMIT 1").get(planet);
  if (!q) {
    q = db.prepare("SELECT * FROM soal WHERE ronde = 'planet' AND planet = ? ORDER BY RANDOM() LIMIT 1").get(planet);
  }

  if (!q) {
    return res.status(404).json({ success: false, message: `Soal untuk planet ${planet} tidak ditemukan!` });
  }

  db.prepare('UPDATE soal SET dipakai = 1 WHERE id = ?').run(q.id);

  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const waktuMic = state.waktu_planet_mic || 60;
  const now = Date.now();

  db.prepare(`
    UPDATE state
    SET planet_terpilih = ?,
        soal_planet_id = ?,
        planet_step = 4,
        waktu_kerja = ?,
        timer_status = 'RUNNING',
        timer_start_server_ts = ?,
        timer_elapsed_seconds = 0,
        hasil_planet_mic = NULL
    WHERE id = 1
  `).run(planet, q.id, waktuMic, now);

  addLog(state.tim_giliran, 'PILIH_PLANET', planet, `Meja MIC memilih planet ${planet} (Soal #${q.id})`);
  broadcastState('PLANET_CHOSEN', { planet });
  res.json({ success: true, state: getFullState(true) });
});

// Step 4: Meja MIC Jury Judgment (BENAR / SALAH)
app.post('/api/host/planet/mic-judge', verifyPinMiddleware, (req, res) => {
  const { hasil } = req.body;
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const teamNo = state.tim_giliran || 1;
  const poinMic = state.poin_planet_mic || 30;
  const poinTab = state.poin_planet_tab || 20;

  if (hasil === 'BENAR') {
    db.prepare('UPDATE tim SET skor = skor + ?, sudah_main = 1 WHERE id = ?').run(poinMic, teamNo);
    db.prepare(`
      INSERT INTO giliran (tim, hasil_tab, planet, hasil_mic, poin_tab, poin_mic)
      VALUES (?, 'BENAR', ?, 'BENAR', ?, ?)
    `).run(teamNo, state.planet_terpilih, poinTab, poinMic);

    db.prepare(`
      UPDATE state
      SET hasil_planet_mic = 'BENAR',
          planet_step = 5,
          timer_status = 'STOPPED'
      WHERE id = 1
    `).run();

    addLog(teamNo, 'PLANET_MIC_BENAR', '', `Meja MIC Benar (+${poinMic} poin) untuk Planet ${state.planet_terpilih}`);
    broadcastState('PLANET_MIC_RESULT', { status: 'BENAR', tim: teamNo, poin: poinMic });
  } else {
    db.prepare('UPDATE tim SET sudah_main = 1 WHERE id = ?').run(teamNo);
    db.prepare(`
      INSERT INTO giliran (tim, hasil_tab, planet, hasil_mic, poin_tab, poin_mic)
      VALUES (?, 'BENAR', ?, 'SALAH', ?, 0)
    `).run(teamNo, state.planet_terpilih, poinTab);

    db.prepare(`
      UPDATE state
      SET hasil_planet_mic = 'SALAH',
          planet_step = 5,
          timer_status = 'STOPPED'
      WHERE id = 1
    `).run();

    addLog(teamNo, 'PLANET_MIC_SALAH', '', `Meja MIC Salah (+0 poin) untuk Planet ${state.planet_terpilih}`);
    broadcastState('PLANET_MIC_RESULT', { status: 'SALAH', tim: teamNo, poin: 0 });
  }

  res.json({ success: true, state: getFullState(true) });
});

// Reset Current Turn
app.post('/api/host/planet/reset-giliran', verifyPinMiddleware, (req, res) => {
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();
  const teamNo = state.tim_giliran;

  db.prepare(`
    UPDATE state
    SET planet_step = 1,
        hasil_planet_tab = NULL,
        hasil_planet_mic = NULL,
        planet_terpilih = NULL,
        soal_planet_id = NULL,
        timer_status = 'STOPPED',
        timer_elapsed_seconds = 0,
        timer_start_server_ts = NULL,
        papan_planet_terkunci_manual = 0
    WHERE id = 1
  `).run();

  addLog(teamNo, 'RESET_GILIRAN_PLANET', '', `Giliran Tim ${teamNo} pada Misi Planet di-reset oleh juri`);
  broadcastState('PLANET_STEP_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// Manual Toggle Planet Board Lock
app.post('/api/host/planet/toggle-papan-lock', verifyPinMiddleware, (req, res) => {
  const state = db.prepare('SELECT papan_planet_terkunci_manual FROM state WHERE id = 1').get();
  const nextVal = state.papan_planet_terkunci_manual ? 0 : 1;
  db.prepare('UPDATE state SET papan_planet_terkunci_manual = ? WHERE id = 1').run(nextVal);
  addLog(null, 'TOGGLE_PAPAN_PLANET', '', `Papan planet dikunci manual: ${nextVal}`);
  broadcastState('PLANET_STEP_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// --------------------------------------------------------------------------
// TEAM MANAGEMENT (Anti-Pemalsuan & PIN Guarded)
// --------------------------------------------------------------------------
app.post('/api/host/tim/toggle-lock', verifyPinMiddleware, (req, res) => {
  const state = db.prepare('SELECT kunci_tim FROM state WHERE id = 1').get();
  const nextLock = state.kunci_tim ? 0 : 1;
  db.prepare('UPDATE state SET kunci_tim = ? WHERE id = 1').run(nextLock);

  addLog(null, nextLock ? 'KUNCI_TIM' : 'BUKA_KUNCI_TIM', '', nextLock ? 'Nama tim dikunci (anti-pemalsuan aktif)' : 'Kunci nama tim dibuka');
  broadcastState('TEAM_LOCK_CHANGE');
  res.json({ success: true, kunci_tim: nextLock });
});

app.post('/api/host/tim/rename', verifyPinMiddleware, (req, res) => {
  const { team_no, nama } = req.body;
  if (!nama || !nama.trim()) {
    return res.status(400).json({ success: false, message: 'Nama tim tidak boleh kosong!' });
  }

  const t = db.prepare('SELECT * FROM tim WHERE id = ?').get(team_no);
  if (!t) return res.status(404).json({ success: false, message: 'Tim tidak ditemukan' });

  db.prepare('UPDATE tim SET nama = ? WHERE id = ?').run(nama.trim(), team_no);
  addLog(team_no, 'GANTI_NAMA_TIM', t.nama, `Nama diubah menjadi "${nama.trim()}"`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true, teams: db.prepare('SELECT id, id AS no, nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca FROM tim ORDER BY urutan ASC, id ASC').all() });
});

app.post('/api/host/tim/koreksi-skor', verifyPinMiddleware, (req, res) => {
  const { team_no, delta, skor_baru } = req.body;
  const t = db.prepare('SELECT * FROM tim WHERE id = ?').get(team_no);
  if (!t) return res.status(404).json({ success: false, message: 'Tim tidak ditemukan' });

  let finalSkor = t.skor;
  if (skor_baru !== undefined) {
    finalSkor = parseInt(skor_baru, 10);
  } else if (delta !== undefined) {
    finalSkor += parseInt(delta, 10);
  }

  db.prepare('UPDATE tim SET skor = ? WHERE id = ?').run(finalSkor, team_no);
  addLog(team_no, 'KOREKSI_SKOR', `Lama: ${t.skor}`, `Skor baru: ${finalSkor}`);
  broadcastState('SCORE_UPDATE');
  res.json({ success: true, teams: db.prepare('SELECT id, id AS no, nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca FROM tim ORDER BY urutan ASC, id ASC').all() });
});

app.post('/api/host/tim/reset-skor', verifyPinMiddleware, (req, res) => {
  db.prepare('UPDATE tim SET skor = 0, terkunci = 0').run();
  db.prepare('DELETE FROM giliran').run();
  addLog(null, 'RESET_SEMUA_SKOR', '', 'Semua skor tim dan giliran di-reset ke 0');
  broadcastState('SCORE_UPDATE');
  res.json({ success: true, teams: db.prepare('SELECT id, id AS no, nama, skor, terkunci, urutan, aktif, sudah_main, peserta_neraca FROM tim ORDER BY urutan ASC, id ASC').all() });
});

app.post('/api/host/tim/unlock-question', verifyPinMiddleware, (req, res) => {
  const { team_no } = req.body;
  db.prepare('UPDATE tim SET terkunci = 0 WHERE id = ?').run(team_no);
  addLog(team_no, 'BUKA_KUNCI_TIM_SOAL', '', `Kunci soal untuk Tim ${team_no} dibuka kembali oleh juri`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// --- Tim dinamis: tambah, hapus, aktif, urutan, peserta_neraca ---

// Tambah satu tim
app.post('/api/host/tim/tambah', verifyPinMiddleware, (req, res) => {
  const { nama } = req.body;
  const st = db.prepare('SELECT kunci_tim FROM state WHERE id = 1').get();
  if (st.kunci_tim) return res.status(403).json({ success: false, message: 'Tim sedang dikunci!' });
  if (!nama || !nama.trim()) return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
  const maxUrutan = db.prepare('SELECT COALESCE(MAX(urutan), 0) as m FROM tim').get().m;
  const result = db.prepare('INSERT INTO tim (nama, urutan, aktif, sudah_main, peserta_neraca) VALUES (?, ?, 1, 0, 1)').run(nama.trim(), maxUrutan + 1);
  addLog(null, 'TAMBAH_TIM', '', `Tim "${nama.trim()}" ditambahkan (id=${result.lastInsertRowid})`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true, id: result.lastInsertRowid });
});

// Tambah banyak tim sekaligus (array names)
app.post('/api/host/tim/tambah-banyak', verifyPinMiddleware, (req, res) => {
  const st = db.prepare('SELECT kunci_tim FROM state WHERE id = 1').get();
  if (st.kunci_tim) return res.status(403).json({ success: false, message: 'Tim sedang dikunci!' });
  const { names } = req.body;
  if (!Array.isArray(names) || names.length === 0) return res.status(400).json({ success: false, message: 'Daftar nama kosong' });
  let maxUrutan = db.prepare('SELECT COALESCE(MAX(urutan), 0) as m FROM tim').get().m;
  const ins = db.prepare('INSERT INTO tim (nama, urutan, aktif, sudah_main, peserta_neraca) VALUES (?, ?, 1, 0, 1)');
  const insertMany = db.transaction((ns) => ns.forEach(n => { if (n.trim()) ins.run(n.trim(), ++maxUrutan); }));
  insertMany(names);
  addLog(null, 'TAMBAH_BANYAK_TIM', '', `${names.filter(n => n.trim()).length} tim ditambahkan`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// Toggle aktif/nonaktif
app.post('/api/host/tim/toggle-aktif', verifyPinMiddleware, (req, res) => {
  const { id } = req.body;
  const t = db.prepare('SELECT * FROM tim WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ success: false, message: 'Tim tidak ditemukan' });
  db.prepare('UPDATE tim SET aktif = ? WHERE id = ?').run(t.aktif ? 0 : 1, id);
  addLog(id, t.aktif ? 'NONAKTIFKAN_TIM' : 'AKTIFKAN_TIM', '', t.nama);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// Hapus tim (hanya jika skor=0 dan belum ada log)
app.delete('/api/host/tim/:id', verifyPinMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const st = db.prepare('SELECT kunci_tim FROM state WHERE id = 1').get();
  if (st.kunci_tim) return res.status(403).json({ success: false, message: 'Tim sedang dikunci!' });
  const t = db.prepare('SELECT * FROM tim WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ success: false, message: 'Tim tidak ditemukan' });
  if (t.skor !== 0) return res.status(400).json({ success: false, message: 'Tidak bisa hapus tim yang sudah punya skor!' });
  const hasLog = db.prepare('SELECT COUNT(*) as c FROM log WHERE tim = ?').get(id).c;
  if (hasLog > 0) return res.status(400).json({ success: false, message: 'Tidak bisa hapus tim yang sudah punya log aktivitas!' });
  db.prepare('DELETE FROM tim WHERE id = ?').run(id);
  addLog(null, 'HAPUS_TIM', '', `Tim "${t.nama}" dihapus`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// Pindah urutan naik/turun
app.post('/api/host/tim/ubah-urutan', verifyPinMiddleware, (req, res) => {
  const { id, arah } = req.body;
  const t = db.prepare('SELECT * FROM tim WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ success: false });
  const neighbor = arah === 'naik'
    ? db.prepare('SELECT * FROM tim WHERE urutan < ? ORDER BY urutan DESC LIMIT 1').get(t.urutan)
    : db.prepare('SELECT * FROM tim WHERE urutan > ? ORDER BY urutan ASC LIMIT 1').get(t.urutan);
  if (neighbor) {
    db.prepare('UPDATE tim SET urutan = ? WHERE id = ?').run(neighbor.urutan, t.id);
    db.prepare('UPDATE tim SET urutan = ? WHERE id = ?').run(t.urutan, neighbor.id);
  }
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// Set peserta Ronde Neraca (checklist)
app.post('/api/host/neraca/set-peserta', verifyPinMiddleware, (req, res) => {
  const { ids } = req.body; // array of tim id
  db.prepare('UPDATE tim SET peserta_neraca = 0').run();
  if (Array.isArray(ids) && ids.length > 0) {
    const stmt = db.prepare('UPDATE tim SET peserta_neraca = 1 WHERE id = ?');
    ids.forEach(id => stmt.run(id));
  }
  db.prepare('UPDATE tim SET terkunci = 0').run();
  addLog(null, 'SET_PESERTA_NERACA', '', `Peserta neraca: [${(ids || []).join(',')}]`);
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// Reset status sudah_main
app.post('/api/host/tim/reset-sudah-main', verifyPinMiddleware, (req, res) => {
  db.prepare('UPDATE tim SET sudah_main = 0').run();
  addLog(null, 'RESET_SUDAH_MAIN', '', 'Status sudah_main direset');
  broadcastState('TEAM_UPDATE');
  res.json({ success: true });
});

// --------------------------------------------------------------------------
// GLOBAL SETTINGS & PIN CHANGE
// --------------------------------------------------------------------------
app.post('/api/host/settings', verifyPinMiddleware, (req, res) => {
  const {
    poin_soal, toleransi_global, waktu_tampil, waktu_kerja, pin_baru, ronde,
    poin_planet_tab, poin_planet_mic, waktu_planet_tab, waktu_planet_mic, mode_soal_dipakai_ulang
  } = req.body;
  const state = db.prepare('SELECT * FROM state WHERE id = 1').get();

  let newPin = state.pin_host;
  if (pin_baru && pin_baru.trim().length >= 4) {
    newPin = pin_baru.trim();
    addLog(null, 'GANTI_PIN_HOST', '', 'PIN Juri berhasil diperbarui');
  }

  db.prepare(`
    UPDATE state
    SET poin_soal = COALESCE(?, poin_soal),
        toleransi_global = COALESCE(?, toleransi_global),
        waktu_tampil = COALESCE(?, waktu_tampil),
        waktu_kerja = COALESCE(?, waktu_kerja),
        ronde = COALESCE(?, ronde),
        poin_planet_tab = COALESCE(?, poin_planet_tab),
        poin_planet_mic = COALESCE(?, poin_planet_mic),
        waktu_planet_tab = COALESCE(?, waktu_planet_tab),
        waktu_planet_mic = COALESCE(?, waktu_planet_mic),
        mode_soal_dipakai_ulang = COALESCE(?, mode_soal_dipakai_ulang),
        pin_host = ?
    WHERE id = 1
  `).run(
    poin_soal !== undefined ? parseInt(poin_soal, 10) : null,
    toleransi_global !== undefined ? parseFloat(toleransi_global) : null,
    waktu_tampil !== undefined ? parseInt(waktu_tampil, 10) : null,
    waktu_kerja !== undefined ? parseInt(waktu_kerja, 10) : null,
    ronde !== undefined ? parseInt(ronde, 10) : null,
    poin_planet_tab !== undefined ? parseInt(poin_planet_tab, 10) : null,
    poin_planet_mic !== undefined ? parseInt(poin_planet_mic, 10) : null,
    waktu_planet_tab !== undefined ? parseInt(waktu_planet_tab, 10) : null,
    waktu_planet_mic !== undefined ? parseInt(waktu_planet_mic, 10) : null,
    mode_soal_dipakai_ulang !== undefined ? parseInt(mode_soal_dipakai_ulang, 10) : null,
    newPin
  );

  broadcastState('SETTINGS_CHANGE');
  res.json({ success: true, state: getFullState(true) });
});

// --------------------------------------------------------------------------
// BANK SOAL CRUD & IMPORT / EXPORT (FILTER RONDE & PLANET)
// --------------------------------------------------------------------------
app.get('/api/soal', (req, res) => {
  const pin = req.headers['x-host-pin'] || req.query.pin;
  const state = db.prepare('SELECT pin_host FROM state WHERE id = 1').get();
  const isHost = Boolean(pin && pin === state.pin_host);

  const { mapel, ronde, planet, search } = req.query;
  let query = 'SELECT * FROM soal WHERE 1=1';
  const params = [];

  if (mapel && mapel !== 'SEMUA') {
    query += ' AND mapel = ?';
    params.push(mapel);
  }
  if (ronde && ronde !== 'SEMUA') {
    query += ' AND ronde = ?';
    params.push(ronde);
  }
  if (planet && planet !== 'SEMUA') {
    query += ' AND planet = ?';
    params.push(planet);
  }
  if (search && search.trim()) {
    query += ' AND (soal LIKE ? OR satuan LIKE ?)';
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }

  query += ' ORDER BY ronde ASC, cadangan ASC, id ASC';
  const list = db.prepare(query).all(...params);

  // Security: Strip kunci and toleransi for non-host
  if (!isHost) {
    list.forEach(item => {
      delete item.kunci;
      delete item.toleransi;
    });
  }

  res.json(list);
});

app.post('/api/soal', verifyPinMiddleware, upload.single('gambar'), (req, res) => {
  const { mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, cadangan, ronde, planet } = req.body;
  const gambarPath = req.file ? `/uploads/${req.file.filename}` : null;

  const result = db.prepare(`
    INSERT INTO soal (mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, gambar, dipakai, cadangan, ronde, planet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    mapel || 'Matematika',
    soal || '',
    parseFloat(kunci) || 0,
    satuan || '',
    parseFloat(toleransi) || 0,
    parseInt(waktu_tampil, 10) || 60,
    parseInt(waktu_kerja, 10) || 120,
    gambarPath,
    cadangan ? 1 : 0,
    ronde || 'neraca',
    planet || null
  );

  addLog(null, 'TAMBAH_SOAL', '', `Soal #${result.lastInsertRowid} (${mapel} - ${ronde || 'neraca'}) ditambahkan`);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/soal/:id', verifyPinMiddleware, upload.single('gambar'), (req, res) => {
  const id = req.params.id;
  const { mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, cadangan, ronde, planet, hapus_gambar } = req.body;

  const current = db.prepare('SELECT * FROM soal WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ success: false, message: 'Soal tidak ditemukan' });

  let gambarPath = current.gambar;
  if (hapus_gambar === 'true' || hapus_gambar === '1') {
    gambarPath = null;
  }
  if (req.file) {
    gambarPath = `/uploads/${req.file.filename}`;
  }

  db.prepare(`
    UPDATE soal
    SET mapel = ?,
        soal = ?,
        kunci = ?,
        satuan = ?,
        toleransi = ?,
        waktu_tampil = ?,
        waktu_kerja = ?,
        gambar = ?,
        cadangan = ?,
        ronde = ?,
        planet = ?
    WHERE id = ?
  `).run(
    mapel || current.mapel,
    soal || current.soal,
    parseFloat(kunci) || current.kunci,
    satuan !== undefined ? satuan : current.satuan,
    toleransi !== undefined ? parseFloat(toleransi) : current.toleransi,
    parseInt(waktu_tampil, 10) || current.waktu_tampil,
    parseInt(waktu_kerja, 10) || current.waktu_kerja,
    gambarPath,
    cadangan !== undefined ? (cadangan ? 1 : 0) : current.cadangan,
    ronde || current.ronde || 'neraca',
    planet !== undefined ? (planet || null) : current.planet,
    id
  );

  addLog(null, 'EDIT_SOAL', '', `Soal #${id} diedit`);
  broadcastState('QUESTION_UPDATED');
  res.json({ success: true });
});

app.delete('/api/soal/:id', verifyPinMiddleware, (req, res) => {
  const id = req.params.id;
  const state = db.prepare('SELECT soal_aktif_id, soal_planet_id FROM state WHERE id = 1').get();
  if (state.soal_aktif_id == id || state.soal_planet_id == id) {
    return res.status(400).json({ success: false, message: 'Tidak dapat menghapus soal yang sedang aktif!' });
  }

  db.prepare('DELETE FROM soal WHERE id = ?').run(id);
  addLog(null, 'HAPUS_SOAL', '', `Soal #${id} dihapus`);
  res.json({ success: true });
});

app.get('/api/soal/export-csv', verifyPinMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM soal ORDER BY id ASC').all();
  let csv = 'id,mapel,soal,kunci,satuan,toleransi,waktu_tampil,waktu_kerja,cadangan,dipakai,ronde,planet\n';
  for (const r of rows) {
    const escapedSoal = `"${String(r.soal).replace(/"/g, '""')}"`;
    const escapedSatuan = `"${String(r.satuan || '').replace(/"/g, '""')}"`;
    const escapedPlanet = `"${String(r.planet || '').replace(/"/g, '""')}"`;
    csv += `${r.id},${r.mapel},${escapedSoal},${r.kunci},${escapedSatuan},${r.toleransi},${r.waktu_tampil},${r.waktu_kerja},${r.cadangan},${r.dipakai},${r.ronde || 'neraca'},${escapedPlanet}\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bank_soal_neraca_kebenaran.csv"');
  res.send(csv);
});

// Import Soal CSV
app.post('/api/soal/import-csv', verifyPinMiddleware, express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), (req, res) => {
  const csvContent = req.body;
  if (!csvContent || typeof csvContent !== 'string') {
    return res.status(400).json({ success: false, message: 'File CSV kosong atau format tidak sesuai' });
  }

  const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 1) {
    return res.status(400).json({ success: false, message: 'CSV tidak memiliki data baris' });
  }

  function parseCSVLine(text) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (inQuotes && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  }

  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const insert = db.prepare(`
    INSERT INTO soal (mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, dipakai, cadangan, ronde, planet)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);

  let count = 0;
  const insertMany = db.transaction((rows) => {
    for (let i = 1; i < rows.length; i++) {
      const cols = parseCSVLine(rows[i]);
      if (cols.length < 3) continue;

      const mapelIdx = header.indexOf('mapel');
      const soalIdx = header.indexOf('soal');
      const kunciIdx = header.indexOf('kunci');
      const satuanIdx = header.indexOf('satuan');
      const tolIdx = header.indexOf('toleransi');
      const wtIdx = header.indexOf('waktu_tampil');
      const wkIdx = header.indexOf('waktu_kerja');
      const cadIdx = header.indexOf('cadangan');
      const rondeIdx = header.indexOf('ronde');
      const planetIdx = header.indexOf('planet');

      const mapel = mapelIdx >= 0 ? cols[mapelIdx] : 'Umum';
      const soal = soalIdx >= 0 ? cols[soalIdx] : cols[1];
      const kunci = kunciIdx >= 0 ? parseFloat(cols[kunciIdx]) : 0;
      const satuan = satuanIdx >= 0 ? cols[satuanIdx] : '';
      const toleransi = tolIdx >= 0 ? parseFloat(cols[tolIdx]) || 0 : 0.01;
      const waktu_tampil = wtIdx >= 0 ? parseInt(cols[wtIdx], 10) || 60 : 60;
      const waktu_kerja = wkIdx >= 0 ? parseInt(cols[wkIdx], 10) || 120 : 120;
      const cadangan = cadIdx >= 0 ? parseInt(cols[cadIdx], 10) || 0 : 0;
      const ronde = rondeIdx >= 0 ? cols[rondeIdx] : 'neraca';
      const planet = (planetIdx >= 0 && cols[planetIdx]) ? cols[planetIdx] : null;

      insert.run(mapel, soal, kunci, satuan, toleransi, waktu_tampil, waktu_kerja, cadangan, ronde, planet);
      count++;
    }
  });

  try {
    insertMany(lines);
    addLog(null, 'IMPORT_CSV_SOAL', '', `Berhasil mengimpor ${count} soal baru dari CSV`);
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal parse CSV: ' + err.message });
  }
});

// Audit Log & DB Export
app.get('/api/export-log-csv', verifyPinMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM log ORDER BY id ASC').all();
  let csv = 'id,waktu,tim,aksi,jawaban,hasil\n';
  for (const r of rows) {
    const escapedWaktu = `"${r.waktu}"`;
    const escapedAksi = `"${String(r.aksi).replace(/"/g, '""')}"`;
    const escapedJawaban = `"${String(r.jawaban || '').replace(/"/g, '""')}"`;
    const escapedHasil = `"${String(r.hasil || '').replace(/"/g, '""')}"`;
    csv += `${r.id},${escapedWaktu},${r.tim || ''},${escapedAksi},${escapedJawaban},${escapedHasil}\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="log_lomba_neraca_kebenaran.csv"');
  res.send(csv);
});

app.get('/api/export-db', verifyPinMiddleware, (req, res) => {
  res.download(dbPath, 'lomba.db');
});

// HTML Routing
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/tablet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tablet.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// LAN IPs
function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[PERINGATAN] Port ${PORT} sedang digunakan oleh proses lain!`);
    console.error(`Tutup proses Node.js lain yang sedang berjalan atau jalankan dengan port lain, contoh:`);
    console.error(`PowerShell: $env:PORT=3001; node server.js`);
    console.error(`CMD:        set PORT=3001 && node server.js\n`);
    process.exit(1);
  } else {
    console.error('[ERROR] Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLanIps();

  console.log('\n===============================================================');
  console.log('   NERACA KEBENARAN - OLYMPIAD COMPETITION SYSTEM (LIVE)      ');
  console.log('   MODE DUKUNGAN: RONDE NERACA & RONDE 5: MISI PLANET         ');
  console.log('===============================================================');
  console.log(` Port Server: ${PORT}`);
  console.log(` Status DB   : Siap (lomba.db)`);
  console.log(` PIN Host    : 1234 (Default)`);
  console.log('---------------------------------------------------------------');
  console.log(' AKSES LOCAL:');
  console.log(`   Portal   : http://localhost:${PORT}`);
  console.log(`   Display  : http://localhost:${PORT}/display  (Videotron/Proyektor)`);
  console.log(`   Tablet   : http://localhost:${PORT}/tablet   (Touchscreen Tim)`);
  console.log(`   Host     : http://localhost:${PORT}/host     (Juri / Admin)`);
  console.log('---------------------------------------------------------------');

  if (lanIps.length > 0) {
    console.log(' AKSES JARINGAN LOKAL (LAN / Wi-Fi Offline):');
    lanIps.forEach(ip => {
      console.log(`   Portal   : http://${ip}:${PORT}`);
      console.log(`   Display  : http://${ip}:${PORT}/display`);
      console.log(`   Tablet   : http://${ip}:${PORT}/tablet`);
      console.log(`   Host     : http://${ip}:${PORT}/host`);
    });
  }

  console.log('---------------------------------------------------------------');
  console.log(' AKSES PUBLIK ONLINE GRATIS (Cloudflare Tunnel):');
  console.log(`   Jalankan: cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('===============================================================\n');
});
