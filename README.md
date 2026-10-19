# Attendance System (versi GitHub Pages)

Sistem absensi karyawan: Dashboard, Data Karyawan, Absensi, Riwayat, Pengajuan Izin & Cuti, dan Laporan.
Fiturnya sama dengan versi Flask. Bedanya, versi ini **statis** (HTML + JavaScript) sehingga bisa dibuka lewat link GitHub Pages dari perangkat mana pun.

Login awal: `admin` / `admin123`

## Cara publish ke GitHub Pages

1. Buat repository baru di GitHub (misalnya `attendance-system`).
2. Upload isi folder ini ke repository (folder `docs/`, `flask-original/`, dan `README.md`).
3. Buka **Settings → Pages**.
4. Pada **Build and deployment**, pilih **Source: Deploy from a branch**, **Branch: `main`**, folder **`/docs`**, lalu **Save**.
5. Tunggu 1–2 menit. Linknya: `https://USERNAME.github.io/NAMA-REPO/`

## Perbedaan penting dari versi Flask

- **Data disimpan di browser** (localStorage), bukan di server. Data di HP dan di laptop terpisah, dan tidak ikut terhapus saat halaman ditutup. Membersihkan data situs di browser akan mengembalikan data awal.
- Tidak ada server, jadi login hanya mencocokkan username dan password di sisi browser. Cocok untuk demo atau pemakaian internal kecil, **bukan** untuk data sensitif.
- Jam absen diambil dari jam perangkat yang membuka halaman (zona waktu tetap WIB/UTC+7).
- **Ekspor Excel** memuat library ExcelJS dari CDN saat tombolnya ditekan, jadi butuh internet. CSV dan Cetak/PDF bekerja offline.

Kalau nanti data perlu dibagi antar perangkat dan antar pengguna, backend (mis. Supabase atau Firebase) perlu ditambahkan. Logika ada di `docs/core.js`, jadi penyimpanannya mudah diganti.

## Struktur

```
docs/
  index.html   halaman utama (SPA)
  app.js       tampilan, routing, modal, grafik, ekspor
  core.js      logika (port dari app.py)
  style.css    gaya (tidak diubah)
flask-original/   versi Flask lama, disimpan sebagai arsip
```

## Menjalankan lokal

Buka folder `docs/` dengan server statis apa pun, misalnya `python -m http.server -d docs 8000`, lalu buka `http://localhost:8000`.
