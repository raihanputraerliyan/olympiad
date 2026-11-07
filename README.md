# ⚖️ Neraca Kebenaran - Web App Lomba Olimpiade Sains
## 🌟 Mode: Ronde Neraca & Ronde 5: Misi Planet

Web application **"Neraca Kebenaran"** dirancang khusus untuk panggung lomba cerdas cermat / olimpiade sains (Matematika, Fisika, Kimia, Astronomi) dengan tampilan visualisasi videotron, tablet buzzer layar sentuh multi-touch, dan panel kendali juri (host) terproteksi PIN.

Dibuat dengan tema gelap (*dark theme*), tipografi besar kontras tinggi, visual fisika neraca mekanik halus, visual Papan Tata Surya 8 Planet, efek suara Web Audio lokal tanpa aset internet eksternal, dan database SQLite lokal (`better-sqlite3`).

---

## 🪐 Mode Baru: "Ronde 5: Misi Planet"

Di samping **Ronde Neraca (Mode Default)**, kini tersedia **Ronde 5: Misi Planet** dengan alur pertandingan bertahap:
1. **Pemilihan Mode & Tim Giliran di `/host`:**
   - Juri memilih mode `🪐 Ronde 5: Misi Planet` dan memilih tim yang gilirannya bertanding (Tim 1–5).
   - Satu tim terbagi menjadi 2 stasiun: **Meja TAB** (menjawab hitungan di tablet) dan **Meja MIC** (menjawab lisan).
2. **Step 1 (Pengumuman Giliran):**
   - Tim yang mendapat giliran tampil besar di `/display` dan `/tablet`.
3. **Step 2 (Meja TAB - Soal Hitungan):**
   - Soal tampil di `/tablet` dan `/display` lengkap dengan formula KaTeX.
   - Timer 120 detik (bisa diatur) berjalan berbasis timestamp server.
   - Tim mengetik angka jawaban di keypad tablet dan menekan tombol **"Submit Jawaban"**.
   - Jawaban dinilai otomatis oleh server dengan toleransi dan tidak bisa diubah setelah disubmit.
   - Jika waktu habis = SALAH.
   - Hasil (`BENAR` / `SALAH`) langsung tampil secara dramatis di `/display`.
4. **Step 3 (Papan Tata Surya - 8 Planet):**
   - Jika **BENAR**: Poin bertambah $+20$, dan `/display` menampilkan **Papan Tata Surya (8 Planet)** yang menyala.
   - Meja MIC memilih 1 planet secara lisan, dan Dewan Juri mengklik planet tersebut di `/host`.
   - Paket soal dari planet itu terbuka secara acak, ditandai terpakai, dan tidak bisa dipilih ulang oleh tim lain.
   - Jika **SALAH**: Papan Tata Surya tampil terkunci (warna abu-abu, ikon gembok 🔒) dan giliran tim selesai.
5. **Step 4 (Meja MIC - Soal Lisan 60 Detik):**
   - Pemegang mic menjawab lisan ke juri dalam waktu 60 detik (bisa diatur).
   - Juri melihat teks soal dan **Kunci Jawaban Resmi** di `/host`.
   - Juri menekan tombol **BENAR (+30 Poin)** atau **SALAH (+0 Poin)** di `/host`. Jika salah, poin $+20$ dari Meja TAB tetap aman.
6. **Step 5 (Selesai):**
   - Skor dan peringkat live diperbarui dengan animasi urutan berubah di papan klasemen `/display`.

---

## 🔒 Aturan Keamanan Kunci Jawaban (Security Rules)

1. **Anti-Kebocoran Kunci Jawaban:**
   - Kunci jawaban (`kunci`) **TIDAK BOLEH** tampil di `/display` maupun `/tablet`, dan otomatis dihapus (*sanitized*) dari seluruh payload WebSocket dan REST endpoint yang diakses publik.
   - Hanya klien `/host` yang terautentikasi dengan PIN Juri sah yang dapat menerima kunci jawaban.
   - Penilaian soal hitungan dilakukan sepenuhnya di server secara aman.
2. **Status Singkat Tanpa Kunci:**
   - Di `/display`, banner kunci jawaban telah dihapus sepenuhnya dan diganti dengan status singkat (`BENAR`, `SALAH`, atau `WAKTU HABIS`).
3. **Mode Soal Dipakai Ulang (Anti-Bocoran Arah):**
   - Tersedia opsi di panel host: *"Mode soal dipakai ulang"*.
   - Jika aktif, sudut neraca saat jawaban salah dibuat tetap ($12^\circ$) dan **tidak menunjukkan arah** (tidak menampilkan apakah jawaban lebih besar atau lebih kecil dari kunci) sehingga tidak membocorkan petunjuk ke tim berikutnya.

---

## 🚀 Fitur Utama & Tiga Tampilan

### 1. 🖥️ `/display` (Layar Videotron / Proyektor Utama - Fullscreen)
- **Tampilan Soal Besar & Jelas:** Formula matematika/fisika/kimia dirender rapi menggunakan KaTeX lokal (mendukung LaTeX seperti `$E=mc^2$`, pecahan, akar, integral).
- **Dukungan Gambar Soal:** Menampilkan diagram, grafik, atau gambar soal beresolusi tinggi.
- **Timer 2-Fase Cerdas:**
  - **Fase 1 (Waktu Tampil Soal):** Default 60 detik (bisa diatur).
  - **Fase 2 (Soal Disembunyikan):** Setelah 60 detik habis, tirai gelap menutup teks soal (*"Soal Telah Disembunyikan"*), memaksa tim mengingat dan berpikir mandiri.
  - **Total Waktu Kerja:** Default 120 detik dengan indikator detik kritis (berkedip merah saat sisa $\le 10$ detik).
- **Neraca Kebenaran SVG (Fisika Mekanik Real-Time):**
  - **Sisi Kiri:** Kunci / Target soal.
  - **Sisi Kanan:** Jawaban dari tim yang menjawab.
  - **Animasi Ayun Halus:** Kemiringan sebanding dengan selisih jawaban terhadap kunci jawaban (maksimal $\pm 20^\circ$).
  - **Piringan Menjaga Sudut:** Piringan neraca menggantung bebas tegak lurus secara gravitasi (*counter-rotated*).
  - **Efek Seimbang:** Jika $|\text{jawaban} - \text{kunci}| \le \text{toleransi}$, neraca mendatar ($0^\circ$), aura hijau neon menyala, dan poin otomatis ditambahkan.
  - **Efek Miring:** Jawaban $>$ kunci $\rightarrow$ sisi kanan turun (kemiringan positif); jawaban $<$ kunci $\rightarrow$ sisi kanan naik (kemiringan negatif).
- **Papan Skor & Ranking Live:** 5 tim diurutkan langsung berdasarkan poin tertinggi dengan animasi perubahan posisi halus (*live rank transition*).
- **Banner Notifikasi Buzzer:** Pop-up besar *"🔔 TIM X MENJAWAB"* saat tim berhasil memenangkan buzzer.
- **Efek Suara Mandiri (Web Audio API):**
  - Bel buzzer nada ganda frekuensi tinggi (*bell resonance*).
  - Fanfara kemenangan akord mayor saat tim menjawab benar.
  - Dentuman berat saat tim menjawab salah atau neraca timpang.
  - **100% offline tanpa membutuhkan file MP3/WAV eksternal!**

---

### 2. 📱 `/tablet` (Layar Sentuh Bersama untuk 5 Tim)
- **1 Tablet untuk Semua:** Diletakkan di tengah meja lomba untuk diakses bersama oleh 5 tim.
- **5 Zona Warna Raksasa (Tim 1–5):**
  - Tim 1: Crimson Red
  - Tim 2: Sky Blue
  - Tim 3: Emerald Green
  - Tim 4: Amber Orange
  - Tim 5: Violet Purple
- **Multi-Touch & Anti-Zoom:** Penanganan sentuhan instan via `touchstart` dengan pencegah pinch-to-zoom dan double-tap zoom (`touch-action: manipulation`).
- **Wake Lock API:** Mencegah layar tablet meredup (*dimming*) atau mati (*sleep*) di tengah pertandingan.
- **Pemenang Tercepat Milidetik:** Timestamp dicatat di server. Sentuhan pertama mengunci zona tim lain secara instan.
- **Mode Input Jawaban:**
  - Begitu Tim X menang buzzer, layar beralih ke keypad angka virtual berukuran besar ($0-9$, tanda minus, titik desimal, tombol Hapus & Clear) serta indikator satuan soal.
  - Tombol raksasa **"⚖️ TIMBANG"** untuk mengirim jawaban langsung ke layar videotron.
- **Anti-Pemalsuan:** Nama tim pada tablet berstatus *Read-Only* (hanya bisa diubah di panel juri). Jika tim salah menjawab, zona tim tersebut otomatis terkunci untuk soal yang bersangkutan, dan buzzer dibuka kembali untuk tim lain jika waktu masih tersisa.

---

### 3. 🎛️ `/host` (Pusat Kendali Juri / Administrator)
- **Dilindungi PIN Juri:** Default PIN: `1234` (dapat diganti kapan saja di tab Pengaturan).
- **Kontrol Penuh Lomba:**
  - Mulai lomba (*Start*), Jeda (*Pause*), Lanjut (*Resume*), Reset timer ke 0, $+10$ detik, $-10$ detik, dan atur sisa waktu manual.
  - Buka / Kunci buzzer.
  - Tombol manual pemilihan tim buzzer 1–5 (jika menggunakan bel fisik atau juri memilih langsung).
  - Input jawaban manual dan tombol "Timbang" langsung dari juri jika tim menjawab lisan.
  - Tombol buka/sembunyikan kunci jawaban resmi ke videotron.
  - Tombol cepat **"Ganti ke Soal Cadangan"**.
  - Reset status soal aktif (membersihkan timbangan).
- **Sistem Anti-Pemalsuan Nama Tim:**
  - Fitur **"Kunci Tim"** sebelum perlombaan dimulai.
  - Saat terkunci, server menolak segala perubahan nama tim kecuali dibuka dengan PIN Juri yang sah.
  - Koreksi skor manual ($+10$, $-10$, set nilai kustom) dan reset skor semua tim.
  - Tombol buka kunci tim yang salah menjawab jika juri ingin memberi kesempatan kembali.
- **Bank Soal Lengkap:**
  - Tambah, edit, dan hapus soal tanpa batas kuota.
  - Filter mata pelajaran (Matematika, Fisika, Kimia, Umum) dan pencarian teks.
  - Input toleransi angka ($\pm$), waktu tampil, waktu kerja, dan penanda soal cadangan.
  - Upload gambar soal (disimpan otomatis di folder `/uploads`).
  - *Live Preview* rendering rumus LaTeX KaTeX saat mengetik soal.
  - Ekspor Bank Soal ke format CSV dan Impor soal massal dari file CSV.
  - Sudah terisi **5 contoh soal utama olimpiade + 2 soal cadangan** saat instalasi pertama.
- **Audit Log & Ekspor Data:**
  - Pencatatan seluruh kejadian secara real-time (waktu, tim, aksi, jawaban, hasil skor).
  - Ekspor seluruh log ke format CSV.
  - Tombol unduh langsung database SQLite (`lomba.db`).

---

## 🛠️ Instalasi & Menjalankan Server

### 1. Prasyarat
- Komputer / Laptop dengan **Node.js** (versi 18 ke atas disarankan).
- Browser modern (Chrome, Edge, Firefox, Safari) di laptop, videotron, maupun tablet.

### 2. Langkah Instalasi
Buka Terminal / PowerShell di folder proyek ini:

```bash
# 1. Masuk ke direktori proyek
cd neraca-kebenaran

# 2. Install dependensi
npm install

# 3. Jalankan server
node server.js
```

Atau menggunakan npm:
```bash
npm start
```

---

## 🌐 Koneksi Jaringan & Penggunaan di Lapangan

### Skenario A: Jaringan Offline / LAN Tanpa Internet (100% Mandiri)
Aplikasi ini **tetap berjalan 100% normal tanpa koneksi internet**, karena seluruh dependensi (Express, WebSocket, SQLite, KaTeX CSS/JS/Fonts, dan Web Audio) disimpan secara lokal.

1. Hubungkan Laptop Server, PC Videotron, dan Tablet ke Router / Wi-Fi lokal yang sama (tidak perlu ada kuota internet).
2. Saat `node server.js` dijalankan, server akan mencetak alamat IP LAN di terminal, contoh:
   ```text
   ===============================================================
      NERACA KEBENARAN - OLYMPIAD COMPETITION SYSTEM (LIVE)      
   ===============================================================
    Port Server: 3000
    Status DB   : Siap (lomba.db)
    PIN Host    : 1234 (Default)
   ---------------------------------------------------------------
    AKSES LOCAL:
      Portal   : http://localhost:3000
      Display  : http://localhost:3000/display  (Videotron/Proyektor)
      Tablet   : http://localhost:3000/tablet   (Touchscreen 5 Tim)
      Host     : http://localhost:3000/host     (Juri / Admin)
   ---------------------------------------------------------------
    AKSES JARINGAN LOKAL (LAN / Wi-Fi Offline):
      Portal   : http://192.168.1.50:3000
      Display  : http://192.168.1.50:3000/display
      Tablet   : http://192.168.1.50:3000/tablet
      Host     : http://192.168.1.50:3000/host
   ---------------------------------------------------------------
   ```
3. Buka browser pada masing-masing perangkat:
   - **PC Videotron / TV Panggung:** Buka `http://192.168.1.50:3000/display` (Tekan tombol **Layar Penuh** atau `F11`).
   - **Tablet Tim:** Buka `http://192.168.1.50:3000/tablet`.
   - **Laptop Juri:** Buka `http://192.168.1.50:3000/host` (Masukkan PIN `1234`).

---

### Skenario B: Akses Publik Online Gratis dengan Cloudflare Tunnel
Jika tablet atau juri berada di lokasi berbeda atau ingin diakses melalui internet publik secara gratis tanpa perlu IP publik statis atau konfigurasi router:

1. Unduh executable gratis [Cloudflare Tunnel (cloudflared)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/).
2. Jalankan perintah berikut di jendela terminal baru saat server Node.js sedang aktif di port 3000:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Cloudflare akan secara otomatis menghasilkan tautan HTTPS acak gratis yang aman, misalnya:
   `https://random-subdomain.trycloudflare.com`
4. Bagikan tautan tersebut:
   - Videotron: `https://random-subdomain.trycloudflare.com/display`
   - Tablet: `https://random-subdomain.trycloudflare.com/tablet`
   - Juri: `https://random-subdomain.trycloudflare.com/host`

---

## 📁 Struktur Direktori

```text
neraca-kebenaran/
├── server.js               # Backend Express, WebSocket Server & SQLite Engine
├── package.json            # Konfigurasi dependensi
├── lomba.db                # Database SQLite (dibuat otomatis jika belum ada)
├── uploads/                # Direktori penyimpanan gambar soal
├── README.md               # Dokumentasi lengkap panduan aplikasi
└── public/
    ├── index.html          # Portal utama pemilihan halaman
    ├── display.html        # Tampilan Videotron / Proyektor layar lebar
    ├── tablet.html         # Tampilan Layar Sentuh Tablet Buzzer 5 Tim
    ├── host.html           # Panel Kontrol Juri (PIN Protected)
    └── vendor/
        └── katex/          # Aset KaTeX Offline (JS, CSS, Font woff/woff2)
            ├── katex.min.js
            ├── katex.min.css
            ├── contrib/
            │   └── auto-render.min.js
            └── fonts/
```

---

## 🔒 Sistem Keamanan & Ketahanan Data

1. **Auto-Reconnect & Sinkronisasi Instan:** Jika koneksi Wi-Fi sempat terputus sesaat, klien browser akan otomatis mencoba menyambung ulang (*exponential backoff*) dan langsung menarik state kompetisi terbaru dari server.
2. **Kekebalan Server Restart (State Persistence):** Seluruh status lomba (ronde, nomor soal aktif, posisi neraca terakhir, tim terkunci, skor, timer, nama tim) disimpan ke dalam database SQLite `lomba.db` dengan mode WAL (*Write-Ahead Logging*). Jika server mendadak restart, pertandingan dapat dilanjutkan kembali tanpa kehilangan data.
3. **Audit Log:** Seluruh peristiwa (buzzer, timbang jawaban, ganti soal, koreksi skor, ganti nama tim) dicatat dengan stempel waktu terperinci dan dapat diekspor sewaktu-waktu oleh panitia lomba.

---
*Dikembangkan untuk perlombaan olimpiade sains yang adil, transparan, dan spektakuler.* ⚖️
