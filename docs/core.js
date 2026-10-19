/* Logika inti Sistem Absensi (port dari app.py Flask ke JavaScript).
   Tidak menyentuh DOM, jadi bisa diuji di Node. Data disimpan di localStorage browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var C = {};

  // ---------- ZONA WAKTU (Asia/Jakarta = UTC+7, tanpa DST) ----------
  var TZ = 7 * 3600 * 1000;
  var NAMA_HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  var NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  C.NAMA_HARI = NAMA_HARI; C.NAMA_BULAN = NAMA_BULAN;

  var nowFn = function () { return Date.now(); };
  C.setNow = function (f) { nowFn = f; };
  function sekarang() { return nowFn(); }
  C.sekarang = sekarang;

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function parts(ms) {
    var d = new Date(ms + TZ);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds() };
  }
  function dateOf(ms) { var p = parts(ms); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
  function toUTC(s) { var a = s.split('-').map(Number); return Date.UTC(a[0], a[1] - 1, a[2]); }
  function fromUTC(t) {
    var d = new Date(t);
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function addDays(s, n) { return fromUTC(toUTC(s) + n * 86400000); }
  function diffDays(a, b) { return Math.round((toUTC(a) - toUTC(b)) / 86400000); }
  function weekday(s) { return (new Date(toUTC(s)).getUTCDay() + 6) % 7; }   // Senin=0
  function secOfDay(ms) { var p = parts(ms); return p.H * 3600 + p.M * 60 + p.S; }
  function hhmm(ms) { var p = parts(ms); return pad(p.H) + ':' + pad(p.M); }
  function hhmmss(ms) { var p = parts(ms); return pad(p.H) + ':' + pad(p.M) + ':' + pad(p.S); }
  function squash(s) { return String(s == null ? '' : s).split(/\s+/).filter(Boolean).join(' '); }
  function len(s) { return Array.from(s).length; }
  function parseTanggal(t) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    var a = t.split('-').map(Number), dt = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
    if (a[0] < 1 || dt.getUTCFullYear() !== a[0] || dt.getUTCMonth() !== a[1] - 1 || dt.getUTCDate() !== a[2]) return null;
    return t;
  }
  C.dateOf = dateOf; C.addDays = addDays; C.diffDays = diffDays; C.weekday = weekday;
  C.hhmm = hhmm; C.hhmmss = hhmmss; C.parseTanggal = parseTanggal; C.toUTC = toUTC;
  C.hariIni = function () { return dateOf(sekarang()); };

  function formatTanggalId(s) {
    var a = s.split('-').map(Number);
    return NAMA_HARI[weekday(s)] + ', ' + a[2] + ' ' + NAMA_BULAN[a[1] - 1] + ' ' + a[0];
  }
  function formatTanggalPendek(s) {
    var a = s.split('-').map(Number);
    return NAMA_HARI[weekday(s)].slice(0, 3) + ', ' + a[2] + ' ' + NAMA_BULAN[a[1] - 1].slice(0, 3) + ' ' + a[0];
  }
  function formatTanggalWaktu(ms) {
    var p = parts(ms);
    return p.d + ' ' + NAMA_BULAN[p.m - 1].slice(0, 3) + ' ' + p.y + ', ' + pad(p.H) + ':' + pad(p.M) + ' WIB';
  }
  function formatRentang(a, b) {
    return a === b ? formatTanggalPendek(a) : formatTanggalPendek(a) + ' – ' + formatTanggalPendek(b);
  }
  function fmtJam(sec) { return pad(Math.floor(sec / 3600)) + '.' + pad(Math.floor(sec % 3600 / 60)); }
  C.formatTanggalId = formatTanggalId; C.formatTanggalPendek = formatTanggalPendek;
  C.formatTanggalWaktu = formatTanggalWaktu; C.formatRentang = formatRentang; C.fmtJam = fmtJam;

  // ---------- KONFIGURASI JADWAL ABSENSI ----------
  var JAM_MULAI_DATANG = 7 * 3600;                 // 07:00
  var JAM_BATAS_TEPAT_WAKTU = 7 * 3600 + 30 * 60;  // 07:30:00 inklusif
  var JAM_MULAI_PULANG = 16 * 3600;                // 16:00
  var HARI_KERJA = [0, 1, 2, 3, 4];
  C.JAM_MULAI_DATANG = JAM_MULAI_DATANG; C.JAM_BATAS_TEPAT_WAKTU = JAM_BATAS_TEPAT_WAKTU;
  C.JAM_MULAI_PULANG = JAM_MULAI_PULANG; C.HARI_KERJA = HARI_KERJA;

  var USERS = { admin: 'admin123' };
  var ADMIN_USERS = ['admin'];
  C.USERS = USERS; C.ADMIN_USERS = ADMIN_USERS;

  var STATUS_KARYAWAN = ['Aktif', 'Nonaktif', 'Cuti'];
  var PER_PAGE = 10;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var HP_RE = /^(?:\+62|62|0)(8\d{8,11})$/;
  var STATUS_RIWAYAT = ['Tepat Waktu', 'Terlambat', 'Tidak Hadir', 'Cuti', 'Izin'];
  var PER_PAGE_RIWAYAT = 20, RENTANG_DEFAULT_HARI = 30, RENTANG_MAKS_HARI = 366;
  var JENIS_PENGAJUAN = ['Izin', 'Cuti'], STATUS_PENGAJUAN = ['Menunggu', 'Disetujui', 'Ditolak'];
  var IZIN_MUNDUR_MAKS_HARI = 7, PENGAJUAN_MAKS_DURASI = 90, PENGAJUAN_MAKS_MAJU_HARI = 365;
  var ALASAN_MIN = 5, ALASAN_MAKS = 500;
  var STATUS_LAPORAN = ['Hadir', 'Terlambat', 'Izin', 'Cuti', 'Tidak Hadir'];
  var PERIODE_LAPORAN = [['hari_ini', 'Hari Ini'], ['minggu_ini', 'Minggu Ini'], ['bulan_ini', 'Bulan Ini'], ['rentang', 'Rentang Tanggal']];
  var NAMA_PERIODE = {}; PERIODE_LAPORAN.forEach(function (p) { NAMA_PERIODE[p[0]] = p[1]; });
  var PER_PAGE_LAPORAN = 20;
  var KOLOM_LAPORAN = ['No.', 'Tanggal', 'ID Karyawan', 'Nama Karyawan', 'Jabatan',
    'Jam Datang', 'Jam Pulang', 'Status Absensi', 'Keterangan'];
  var JUMLAH_LOG_DASHBOARD = 5;
  C.STATUS_KARYAWAN = STATUS_KARYAWAN; C.PER_PAGE = PER_PAGE; C.STATUS_RIWAYAT = STATUS_RIWAYAT;
  C.PER_PAGE_RIWAYAT = PER_PAGE_RIWAYAT; C.JENIS_PENGAJUAN = JENIS_PENGAJUAN;
  C.STATUS_PENGAJUAN = STATUS_PENGAJUAN; C.STATUS_LAPORAN = STATUS_LAPORAN;
  C.PERIODE_LAPORAN = PERIODE_LAPORAN; C.NAMA_PERIODE = NAMA_PERIODE;
  C.PER_PAGE_LAPORAN = PER_PAGE_LAPORAN; C.KOLOM_LAPORAN = KOLOM_LAPORAN; C.ALASAN_MAKS = ALASAN_MAKS;

  // ---------- PENYIMPANAN (localStorage; fallback ke memori) ----------
  var KEY = 'absensi_db_v1';
  var db = null;

  function seed() {
    var today = dateOf(sekarang());
    function w(ago, h, m) {
      var a = addDays(today, -ago).split('-').map(Number);
      return Date.UTC(a[0], a[1] - 1, a[2], h - 7, m);
    }
    return {
      karyawan: [
        { id: 'EMP001', nama: 'Andi Pratama', jabatan: 'Software Engineer', email: 'andi@company.com', hp: '0812-3456-7890', status: 'Aktif' },
        { id: 'EMP002', nama: 'Sari Dewi', jabatan: 'HR Manager', email: 'sari@company.com', hp: '0812-3456-7891', status: 'Aktif' },
        { id: 'EMP003', nama: 'Budi Santoso', jabatan: 'Marketing Staff', email: 'budi@company.com', hp: '0812-3456-7892', status: 'Nonaktif' },
        { id: 'EMP004', nama: 'Dewi Puspa', jabatan: 'Finance Analyst', email: 'dewi@company.com', hp: '0812-3456-7893', status: 'Aktif' },
        { id: 'EMP005', nama: 'Rudi Hartono', jabatan: 'IT Support', email: 'rudi@company.com', hp: '0812-3456-7894', status: 'Aktif' }
      ],
      log: [
        { id_karyawan: 'EMP001', waktu: w(0, 8, 1), jenis: 'Check In', status: 'Tepat Waktu' },
        { id_karyawan: 'EMP002', waktu: w(0, 8, 15), jenis: 'Check In', status: 'Terlambat' },
        { id_karyawan: 'EMP003', waktu: w(0, 17, 2), jenis: 'Check Out', status: 'Tepat Waktu' },
        { id_karyawan: 'EMP005', waktu: w(1, 8, 5), jenis: 'Check In', status: 'Tepat Waktu' },
        { id_karyawan: 'EMP001', waktu: w(1, 8, 0), jenis: 'Check In', status: 'Tepat Waktu' }
      ],
      pengajuan: []
    };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* mode privat: data hanya di memori */ }
  }
  C.load = function () {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (raw) {
      try {
        var d = JSON.parse(raw);
        if (d && d.karyawan && d.log && d.pengajuan) { db = d; return db; }
      } catch (e) {}
    }
    db = seed(); save(); return db;
  };
  C.reset = function () { db = seed(); save(); return db; };
  C.setDB = function (d) { db = d; };
  C.getDB = function () { if (!db) C.load(); return db; };
  function D() { return C.getDB(); }

  // ---------- STATISTIK DASHBOARD ----------
  function aktif(k) { return k.status === 'Aktif' && !k.dihapus; }
  function persen(bagian, dasar) { return dasar ? Math.floor(bagian * 100 / dasar + 0.5) : 0; }

  function indeksDisetujui(pengajuan) {
    var hasil = {};
    (pengajuan || D().pengajuan).forEach(function (p) {
      if (p.status === 'Disetujui') (hasil[p.id_karyawan] = hasil[p.id_karyawan] || []).push(p);
    });
    return hasil;
  }
  function disetujuiPada(indeks, kid, tanggal) {
    var l = indeks[kid] || [];
    for (var i = 0; i < l.length; i++) if (l[i].mulai <= tanggal && tanggal <= l[i].selesai) return l[i];
    return null;
  }
  function pengajuanDisetujui(kid, tanggal, pengajuan) { return disetujuiPada(indeksDisetujui(pengajuan), kid, tanggal); }

  C.hitungStatistik = function (karyawan, log, hariIni, pengajuan) {
    var aktifIds = {}; karyawan.forEach(function (k) { if (aktif(k)) aktifIds[k.id] = 1; });
    var hadir = {}, terlambat = {};
    log.forEach(function (rec) {
      if (typeof rec.waktu !== 'number') return;
      if (dateOf(rec.waktu) !== hariIni) return;
      if (rec.jenis !== 'Check In' && rec.jenis !== 'Check Out') return;
      if (!aktifIds[rec.id_karyawan]) return;
      hadir[rec.id_karyawan] = 1;
      if (rec.jenis === 'Check In' && rec.status === 'Terlambat') terlambat[rec.id_karyawan] = 1;
    });
    var totalAktif = Object.keys(aktifIds).length, nHadir = Object.keys(hadir).length, nTerlambat = Object.keys(terlambat).length;
    var idx = indeksDisetujui(pengajuan);
    var izinCuti = Object.keys(aktifIds).filter(function (id) { return !hadir[id] && disetujuiPada(idx, id, hariIni); }).length;
    var tidak = totalAktif - nHadir - izinCuti;
    return {
      total: karyawan.filter(function (k) { return !k.dihapus; }).length,
      aktif: totalAktif, hadir: nHadir, terlambat: nTerlambat, izin_cuti: izinCuti, tidak_hadir: tidak,
      persen_hadir: persen(nHadir, totalAktif), persen_terlambat: persen(nTerlambat, totalAktif),
      persen_tidak_hadir: persen(tidak, totalAktif)
    };
  };

  C.logTerbaru = function (karyawan, log, batas) {
    batas = batas || JUMLAH_LOG_DASHBOARD;
    var nama = {}; karyawan.forEach(function (k) { nama[k.id] = k.nama; });
    var valid = log.filter(function (r) { return typeof r.waktu === 'number' && nama[r.id_karyawan] !== undefined; });
    valid.sort(function (a, b) { return b.waktu - a.waktu; });
    return valid.slice(0, batas).map(function (r) {
      return { nama: nama[r.id_karyawan], waktu: hhmm(r.waktu), tanggal: dateOf(r.waktu), jenis: r.jenis, status: r.status };
    });
  };

  // ---------- DATA KARYAWAN ----------
  function karyawanTerlihat() { return D().karyawan.filter(function (k) { return !k.dihapus; }); }
  function cariKaryawan(kid) {
    var l = D().karyawan;
    for (var i = 0; i < l.length; i++) if (l[i].id === kid && !l[i].dihapus) return l[i];
    return null;
  }
  function cariKaryawanSemua(kid) {
    var l = D().karyawan;
    for (var i = 0; i < l.length; i++) if (l[i].id === kid) return l[i];
    return null;
  }
  C.karyawanTerlihat = karyawanTerlihat; C.cariKaryawan = cariKaryawan; C.cariKaryawanSemua = cariKaryawanSemua;

  function buatIdBaru() {
    var maks = 0;
    D().karyawan.forEach(function (k) { var m = /^EMP(\d+)$/.exec(k.id); if (m) maks = Math.max(maks, parseInt(m[1], 10)); });
    return 'EMP' + pad(maks + 1, 3);
  }
  function normalisasiHp(mentah) {
    var bersih = mentah.replace(/[\s\-().]/g, ''), m = HP_RE.exec(bersih);
    if (!m) return null;
    var n = '0' + m[1];
    return n.slice(0, 4) + '-' + n.slice(4, 8) + '-' + n.slice(8);
  }

  function validasiKaryawan(form, idSendiri, denganStatus) {
    var nilai = {
      nama: squash(form.nama), email: String(form.email || '').trim(),
      hp: String(form.hp || '').trim(), jabatan: squash(form.jabatan)
    };
    if (denganStatus) nilai.status = String(form.status || '').trim();
    var errors = {};
    if (!nilai.nama) errors.nama = 'Nama lengkap wajib diisi.';
    else if (len(nilai.nama) < 2 || len(nilai.nama) > 100) errors.nama = 'Nama harus 2–100 karakter.';

    if (!nilai.email) errors.email = 'Email wajib diisi.';
    else if (len(nilai.email) > 254 || !EMAIL_RE.test(nilai.email)) errors.email = 'Format email tidak valid.';
    else {
      var email = nilai.email.toLowerCase();
      var dipakai = karyawanTerlihat().some(function (k) { return k.email.toLowerCase() === email && k.id !== idSendiri; });
      if (dipakai) errors.email = 'Email sudah digunakan karyawan lain.';
      else nilai.email = email;
    }
    if (!nilai.hp) errors.hp = 'Nomor HP wajib diisi.';
    else {
      var hp = normalisasiHp(nilai.hp);
      if (hp === null) errors.hp = 'Nomor HP tidak valid. Contoh: 081234567890 atau +6281234567890.';
      else nilai.hp = hp;
    }
    if (!nilai.jabatan) errors.jabatan = 'Jabatan wajib diisi.';
    else if (len(nilai.jabatan) < 2 || len(nilai.jabatan) > 100) errors.jabatan = 'Jabatan harus 2–100 karakter.';
    if (denganStatus && STATUS_KARYAWAN.indexOf(nilai.status) < 0) errors.status = 'Status harus Aktif, Nonaktif, atau Cuti.';
    return { nilai: nilai, errors: errors };
  }

  function daftarHalaman(page, jumlah, lebar) {
    lebar = lebar || 1;
    var i, out = [];
    if (jumlah <= 7) { for (i = 1; i <= jumlah; i++) out.push(i); return out; }
    var set = { 1: 1 }; set[jumlah] = 1;
    for (i = page - lebar; i <= page + lebar; i++) set[i] = 1;
    var nums = Object.keys(set).map(Number).filter(function (x) { return x >= 1 && x <= jumlah; }).sort(function (a, b) { return a - b; });
    var prev = 0;
    nums.forEach(function (n) { if (n - prev > 1) out.push(null); out.push(n); prev = n; });
    return out;
  }
  C.daftarHalaman = daftarHalaman;

  function cocok(k, kw) {
    var kwAngka = kw.replace(/\D/g, '');
    var f = ['id', 'nama', 'jabatan', 'email', 'hp'];
    for (var i = 0; i < f.length; i++) if (String(k[f[i]]).toLowerCase().indexOf(kw) >= 0) return true;
    return !!kwAngka && k.hp.replace(/\D/g, '').indexOf(kwAngka) >= 0;
  }

  C.daftarKaryawan = function (q, page) {
    q = (q || '').trim();
    var semua = karyawanTerlihat();
    var hasil = q ? semua.filter(function (k) { return cocok(k, q.toLowerCase()); }) : semua;
    var total = hasil.length, jumlahHal = Math.max(1, Math.ceil(total / PER_PAGE));
    page = Math.min(Math.max(page || 1, 1), jumlahHal);
    var mulai = (page - 1) * PER_PAGE, data = hasil.slice(mulai, mulai + PER_PAGE);
    return { data: data, q: q, page: page, jumlahHal: jumlahHal, halaman: daftarHalaman(page, jumlahHal),
      total: total, awal: data.length ? mulai + 1 : 0, akhir: mulai + data.length };
  };

  C.karyawanTambah = function (form) {
    var v = validasiKaryawan(form);
    if (Object.keys(v.errors).length) return { errors: v.errors, nilai: v.nilai };
    var baru = Object.assign({ id: buatIdBaru() }, v.nilai, { status: 'Aktif' });
    D().karyawan.push(baru); save();
    var halamanAkhir = Math.max(1, Math.ceil(karyawanTerlihat().length / PER_PAGE));
    return { baru: baru, halamanAkhir: halamanAkhir };
  };
  C.karyawanEdit = function (kid, form) {
    var k = cariKaryawan(kid);
    if (!k) return { tidakAda: true };
    var v = validasiKaryawan(form, kid, true);
    if (Object.keys(v.errors).length) return { errors: v.errors, nilai: v.nilai };
    Object.assign(k, v.nilai); save();
    return { k: k };
  };
  C.karyawanHapus = function (kid) {
    var k = cariKaryawan(kid);
    if (!k) return { tidakAda: true };
    k.dihapus = true; save();
    return { k: k };
  };

  // ---------- ABSENSI HARIAN ----------
  function catatanHari(kid, jenis, tanggal) {
    var l = D().log;
    for (var i = 0; i < l.length; i++) {
      var r = l[i];
      if (r.id_karyawan === kid && r.jenis === jenis && typeof r.waktu === 'number' && dateOf(r.waktu) === tanggal) return r;
    }
    return null;
  }
  function statusDatang(ms) { return secOfDay(ms) <= JAM_BATAS_TEPAT_WAKTU ? 'Tepat Waktu' : 'Terlambat'; }
  function periksaKaryawan(kid) {
    if (!kid) return [null, 'Silakan pilih nama karyawan terlebih dahulu.'];
    var k = cariKaryawan(kid);
    if (!k) return [null, 'Karyawan tidak terdaftar. Pilih nama dari daftar yang tersedia.'];
    if (k.status !== 'Aktif') return [null, k.nama + ' berstatus ' + k.status + ' dan tidak dapat melakukan absensi.'];
    return [k, null];
  }
  C.catatAbsenDatang = function (kid, ms) {
    ms = Math.floor(ms / 1000) * 1000;
    var pk = periksaKaryawan(kid), k = pk[0];
    if (pk[1]) return ['error', pk[1]];
    var sudah = catatanHari(k.id, 'Check In', dateOf(ms));
    if (sudah) return ['error', k.nama + ' sudah melakukan absen datang hari ini pukul ' + hhmmss(sudah.waktu) + ' WIB.'];
    var status = statusDatang(ms);
    D().log.push({ id_karyawan: k.id, waktu: ms, jenis: 'Check In', status: status }); save();
    var pesan = 'Absen datang berhasil: ' + k.nama + ' (' + k.id + ') tercatat pukul ' + hhmmss(ms) + ' WIB';
    if (status === 'Terlambat') return ['warning', pesan + ' dengan status Terlambat.'];
    if (secOfDay(ms) < JAM_MULAI_DATANG) pesan += ' (lebih awal dari jadwal mulai ' + fmtJam(JAM_MULAI_DATANG) + ' WIB)';
    return ['success', pesan + ', status Tepat Waktu.'];
  };
  C.catatAbsenPulang = function (kid, ms) {
    ms = Math.floor(ms / 1000) * 1000;
    var pk = periksaKaryawan(kid), k = pk[0];
    if (pk[1]) return ['error', pk[1]];
    var tgl = dateOf(ms);
    if (!catatanHari(k.id, 'Check In', tgl)) return ['error', 'Silakan lakukan absen datang terlebih dahulu.'];
    var sudah = catatanHari(k.id, 'Check Out', tgl);
    if (sudah) return ['error', k.nama + ' sudah melakukan absen pulang hari ini pukul ' + hhmmss(sudah.waktu) + ' WIB.'];
    if (secOfDay(ms) < JAM_MULAI_PULANG)
      return ['error', 'Jadwal absen pulang belum dimulai. Absen pulang dibuka mulai pukul ' + fmtJam(JAM_MULAI_PULANG) + ' WIB.'];
    D().log.push({ id_karyawan: k.id, waktu: ms, jenis: 'Check Out', status: 'Tepat Waktu' }); save();
    return ['success', 'Absen pulang berhasil: ' + k.nama + ' (' + k.id + ') tercatat pukul ' + hhmmss(ms) + ' WIB.'];
  };
  C.jadwal = function () {
    return { mulai_datang: fmtJam(JAM_MULAI_DATANG), batas_tepat: fmtJam(JAM_BATAS_TEPAT_WAKTU), mulai_pulang: fmtJam(JAM_MULAI_PULANG) };
  };
  C.karyawanAktifUrut = function () {
    return karyawanTerlihat().filter(function (k) { return k.status === 'Aktif'; })
      .sort(function (a, b) { var x = a.nama.toLowerCase(), y = b.nama.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  };

  // ---------- RIWAYAT ABSENSI ----------
  function intArg(v, def) { return /^\s*[-+]?\d+\s*$/.test(String(v)) ? parseInt(v, 10) : def; }
  C.intArg = intArg;

  C.parseFilterRiwayat = function (args, hariIni) {
    var errors = [];
    var q = squash(args.get('q', '')).slice(0, 100);
    var status = String(args.get('status', '')).trim();
    if (STATUS_RIWAYAT.indexOf(status) < 0) status = '';
    var mDari = String(args.get('dari', '')).trim(), mSampai = String(args.get('sampai', '')).trim();
    var sampai = mSampai ? parseTanggal(mSampai) : hariIni;
    if (sampai === null) { errors.push('Format tanggal akhir tidak valid.'); sampai = hariIni; }
    var dari = mDari ? parseTanggal(mDari) : addDays(sampai, -(RENTANG_DEFAULT_HARI - 1));
    if (dari === null) { errors.push('Format tanggal awal tidak valid.'); dari = addDays(sampai, -(RENTANG_DEFAULT_HARI - 1)); }
    if (!errors.length) {
      if (dari > sampai) errors.push('Tanggal awal tidak boleh melebihi tanggal akhir.');
      else if (diffDays(sampai, dari) + 1 > RENTANG_MAKS_HARI) errors.push('Rentang tanggal maksimal ' + RENTANG_MAKS_HARI + ' hari.');
    }
    return { f: { q: q, dari: dari, sampai: sampai, status: status }, errors: errors };
  };

  function keterangan(status, datang, adaPulang, tanggal, hariIni) {
    if (status === 'Tidak Hadir') return 'Tidak ada absen datang';
    if (status === 'Cuti') return 'Sedang cuti';
    var cat = [];
    if (status === 'Terlambat') {
      var menit = Math.ceil((secOfDay(datang) - JAM_BATAS_TEPAT_WAKTU) / 60);
      cat.push(menit > 0 ? 'Terlambat ' + menit + ' menit' : 'Terlambat');
    } else if (secOfDay(datang) < JAM_MULAI_DATANG) cat.push('Datang lebih awal');
    if (!adaPulang) cat.push(tanggal >= hariIni ? 'Belum absen pulang' : 'Tidak absen pulang');
    return cat.join('; ');
  }

  function bangunRiwayat(karyawan, log, dari, sampai, hariIni, q, status, pengajuan) {
    q = q || ''; status = status || '';
    var disetujui = indeksDisetujui(pengajuan), kw = q.toLowerCase();
    var byId = {}, urut = [];
    karyawan.forEach(function (k) {
      if (!kw || k.id.toLowerCase().indexOf(kw) >= 0 || k.nama.toLowerCase().indexOf(kw) >= 0) { byId[k.id] = k; urut.push(k); }
    });
    var masuk = {}, keluar = {};
    log.forEach(function (rec) {
      var w = rec.waktu, kid = rec.id_karyawan;
      if (typeof w !== 'number' || !byId[kid]) return;
      var tgl = dateOf(w);
      if (tgl < dari || tgl > sampai) return;
      var key = kid + '|' + tgl;
      if (rec.jenis === 'Check In') { if (!(key in masuk) || w < masuk[key][0]) masuk[key] = [w, rec.status]; }
      else if (rec.jenis === 'Check Out') { if (!(key in keluar) || w > keluar[key]) keluar[key] = w; }
    });
    function baris(k, tgl, datang, pulang, st, ket) {
      datang = datang === undefined ? null : datang; pulang = pulang === undefined ? null : pulang;
      return { tanggal: tgl, id: k.id, nama: k.nama, jabatan: k.jabatan || '', datang: datang, pulang: pulang, status: st,
        keterangan: ket != null ? ket : keterangan(st, datang, pulang !== null, tgl, hariIni) };
    }
    var rows = [];
    Object.keys(masuk).forEach(function (key) {
      var i = key.indexOf('|'), kid = key.slice(0, i), tgl = key.slice(i + 1);
      rows.push(baris(byId[kid], tgl, masuk[key][0], key in keluar ? keluar[key] : null, masuk[key][1]));
    });
    var hari = dari, batas = sampai < hariIni ? sampai : hariIni;
    while (hari <= batas) {
      if (HARI_KERJA.indexOf(weekday(hari)) >= 0) {
        urut.forEach(function (k) {
          if (k.dihapus || (k.id + '|' + hari) in masuk) return;
          var izin = (k.status === 'Aktif' || k.status === 'Cuti') ? disetujuiPada(disetujui, k.id, hari) : null;
          if (izin) rows.push(baris(k, hari, null, null, izin.jenis, izin.jenis + ' disetujui (' + izin.id + ')'));
          else if (k.status === 'Aktif') rows.push(baris(k, hari, null, null, 'Tidak Hadir'));
          else if (k.status === 'Cuti' && hari === hariIni) rows.push(baris(k, hari, null, null, 'Cuti'));
        });
      }
      hari = addDays(hari, 1);
    }
    if (status) rows = rows.filter(function (r) { return r.status === status; });
    rows.sort(function (a, b) { var x = a.nama.toLowerCase(), y = b.nama.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
    rows.sort(function (a, b) {
      if (a.tanggal !== b.tanggal) return a.tanggal < b.tanggal ? 1 : -1;
      var ha = a.datang !== null ? 1 : 0, hb = b.datang !== null ? 1 : 0;
      if (ha !== hb) return hb - ha;
      return (b.datang || 0) - (a.datang || 0);
    });
    return rows;
  }
  C.bangunRiwayat = bangunRiwayat;

  C.statistikRiwayat = function (rows) {
    return {
      hadir: rows.filter(function (r) { return r.datang !== null; }).length,
      terlambat: rows.filter(function (r) { return r.status === 'Terlambat'; }).length,
      tidak_hadir: rows.filter(function (r) { return r.status === 'Tidak Hadir'; }).length
    };
  };
  C.argsFilterRiwayat = function (f) { return { q: f.q || null, dari: f.dari, sampai: f.sampai, status: f.status || null }; };

  // ---------- CSV ----------
  function selCsv(teks) { teks = String(teks); return '\t\r=+-@'.indexOf(teks.charAt(0)) >= 0 && teks !== '' ? "'" + teks : teks; }
  function csvCell(v) { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function csvText(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

  C.csvRiwayat = function (rows) {
    var out = [['Tanggal', 'ID Karyawan', 'Nama', 'Jabatan', 'Jam Datang', 'Jam Pulang', 'Status', 'Keterangan']];
    rows.forEach(function (r) {
      out.push([r.tanggal, selCsv(r.id), selCsv(r.nama), selCsv(r.jabatan),
        r.datang !== null ? hhmm(r.datang) : '', r.pulang !== null ? hhmm(r.pulang) : '', r.status, r.keterangan]);
    });
    return csvText(out);
  };

  // ---------- PENGAJUAN IZIN & CUTI ----------
  function hitungHari(mulai, selesai) {
    var n = diffDays(selesai, mulai) + 1, kerja = 0;
    for (var i = 0; i < n; i++) if (HARI_KERJA.indexOf(weekday(addDays(mulai, i))) >= 0) kerja++;
    return [n, kerja];
  }
  function cariBentrok(kid, mulai, selesai, statusCek, kecuali) {
    statusCek = statusCek || ['Menunggu', 'Disetujui'];
    var l = D().pengajuan;
    for (var i = 0; i < l.length; i++) {
      var p = l[i];
      if (p.id_karyawan === kid && statusCek.indexOf(p.status) >= 0 && p.id !== kecuali && p.mulai <= selesai && p.selesai >= mulai) return p;
    }
    return null;
  }
  function buatIdPengajuan() {
    var maks = 0;
    D().pengajuan.forEach(function (p) { var m = /^PGJ-(\d+)$/.exec(p.id); if (m) maks = Math.max(maks, parseInt(m[1], 10)); });
    return 'PGJ-' + pad(maks + 1, 4);
  }

  function validasiPengajuan(form, hariIni) {
    var nilai = {
      id_karyawan: String(form.id_karyawan || '').trim(), jenis: String(form.jenis || '').trim(),
      mulai: String(form.mulai || '').trim(), selesai: String(form.selesai || '').trim(), alasan: squash(form.alasan)
    };
    var errors = {}, k = null;
    if (!nilai.id_karyawan) errors.id_karyawan = 'Nama karyawan wajib dipilih.';
    else {
      k = cariKaryawan(nilai.id_karyawan);
      if (!k) errors.id_karyawan = 'Karyawan tidak terdaftar. Pilih nama dari daftar yang tersedia.';
      else if (k.status !== 'Aktif') {
        errors.id_karyawan = k.nama + ' berstatus ' + k.status + ' dan tidak dapat dipilih untuk pengajuan baru.'; k = null;
      }
    }
    if (!nilai.jenis) errors.jenis = 'Jenis pengajuan wajib dipilih.';
    else if (JENIS_PENGAJUAN.indexOf(nilai.jenis) < 0) errors.jenis = 'Jenis pengajuan harus Izin atau Cuti.';

    var mulai = null, selesai = null;
    if (!nilai.mulai) errors.mulai = 'Tanggal mulai wajib diisi.';
    else if ((mulai = parseTanggal(nilai.mulai)) === null) errors.mulai = 'Format tanggal mulai tidak valid.';
    if (!nilai.selesai) errors.selesai = 'Tanggal selesai wajib diisi.';
    else if ((selesai = parseTanggal(nilai.selesai)) === null) errors.selesai = 'Format tanggal selesai tidak valid.';

    if (mulai && selesai) {
      if (selesai < mulai) errors.selesai = 'Tanggal selesai tidak boleh lebih awal daripada tanggal mulai.';
      else if (diffDays(selesai, mulai) + 1 > PENGAJUAN_MAKS_DURASI) errors.selesai = 'Durasi pengajuan maksimal ' + PENGAJUAN_MAKS_DURASI + ' hari.';
    }
    if (mulai && !errors.mulai) {
      if (nilai.jenis === 'Cuti' && mulai < hariIni) errors.mulai = 'Cuti tidak dapat diajukan untuk tanggal yang sudah lewat.';
      else if (mulai < addDays(hariIni, -IZIN_MUNDUR_MAKS_HARI)) errors.mulai = 'Izin hanya dapat diajukan mundur maksimal ' + IZIN_MUNDUR_MAKS_HARI + ' hari.';
      else if (mulai > addDays(hariIni, PENGAJUAN_MAKS_MAJU_HARI)) errors.mulai = 'Tanggal mulai terlalu jauh ke depan (maksimal 1 tahun).';
    }
    if (!nilai.alasan) errors.alasan = 'Alasan pengajuan wajib diisi.';
    else if (len(nilai.alasan) < ALASAN_MIN) errors.alasan = 'Alasan minimal ' + ALASAN_MIN + ' karakter.';
    else if (len(nilai.alasan) > ALASAN_MAKS) errors.alasan = 'Alasan maksimal ' + ALASAN_MAKS + ' karakter.';

    if (k && mulai && selesai && !Object.keys(errors).length) {
      var b = cariBentrok(k.id, mulai, selesai);
      if (b) errors.mulai = 'Bertabrakan dengan pengajuan ' + b.id + ' (' + b.jenis + ', ' + formatRentang(b.mulai, b.selesai) +
        ') yang berstatus ' + b.status + '.';
    }
    return { nilai: nilai, errors: errors, mulai: mulai, selesai: selesai };
  }

  C.parseFilterPengajuan = function (args) {
    var errors = [];
    var q = squash(args.get('q', '')).slice(0, 100);
    var jenis = String(args.get('jenis', '')).trim(), status = String(args.get('status', '')).trim();
    if (JENIS_PENGAJUAN.indexOf(jenis) < 0) jenis = '';
    if (STATUS_PENGAJUAN.indexOf(status) < 0) status = '';
    var dS = String(args.get('dari', '')).trim(), sS = String(args.get('sampai', '')).trim();
    var dari = dS ? parseTanggal(dS) : null, sampai = sS ? parseTanggal(sS) : null;
    if (dS && dari === null) errors.push('Format tanggal awal tidak valid.');
    if (sS && sampai === null) errors.push('Format tanggal akhir tidak valid.');
    if (dari && sampai && dari > sampai) errors.push('Tanggal awal tidak boleh melebihi tanggal akhir.');
    return { f: { q: q, jenis: jenis, status: status, dari: dari, sampai: sampai }, errors: errors };
  };
  C.argsPengajuan = function (f) {
    return { q: f.q || null, jenis: f.jenis || null, status: f.status || null, dari: f.dari || null, sampai: f.sampai || null };
  };
  C.ringkasanPengajuan = function (p) {
    p = p || D().pengajuan;
    var n = function (s) { return p.filter(function (x) { return x.status === s; }).length; };
    return { total: p.length, menunggu: n('Menunggu'), disetujui: n('Disetujui'), ditolak: n('Ditolak') };
  };
  C.bangunPengajuan = function (pengajuan, karyawan, f) {
    var byId = {}; karyawan.forEach(function (k) { byId[k.id] = k; });
    var kw = f.q.toLowerCase(), rows = [];
    pengajuan.forEach(function (p) {
      var k = byId[p.id_karyawan], nama = k ? k.nama : p.id_karyawan;
      if (kw && nama.toLowerCase().indexOf(kw) < 0 && p.id_karyawan.toLowerCase().indexOf(kw) < 0) return;
      if (f.jenis && p.jenis !== f.jenis) return;
      if (f.status && p.status !== f.status) return;
      if (f.dari && p.selesai < f.dari) return;
      if (f.sampai && p.mulai > f.sampai) return;
      var h = hitungHari(p.mulai, p.selesai);
      rows.push(Object.assign({}, p, {
        nama: nama, jabatan: k ? (k.jabatan || '') : '',
        karyawan_status: k ? (k.dihapus ? 'Dihapus' : (k.status || '')) : '', durasi: h[0], hari_kerja: h[1]
      }));
    });
    rows.sort(function (a, b) {
      if (a.diajukan !== b.diajukan) return b.diajukan - a.diajukan;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return rows;
  };
  C.detailPengajuan = function (r) {
    return {
      id: r.id, id_karyawan: r.id_karyawan, nama: r.nama, jabatan: r.jabatan || '—', karyawan_status: r.karyawan_status,
      jenis: r.jenis, status: r.status, mulai: formatTanggalId(r.mulai), selesai: formatTanggalId(r.selesai),
      durasi: r.durasi + ' hari kalender (' + r.hari_kerja + ' hari kerja)', alasan: r.alasan,
      diajukan: formatTanggalWaktu(r.diajukan), diajukan_oleh: r.diajukan_oleh || '—',
      diproses_oleh: r.diproses_oleh || '', diproses_pada: r.diproses_pada ? formatTanggalWaktu(r.diproses_pada) : '',
      alasan_penolakan: r.alasan_penolakan || ''
    };
  };

  C.pengajuanBuat = function (form, user) {
    var v = validasiPengajuan(form, dateOf(sekarang()));
    if (Object.keys(v.errors).length) return { errors: v.errors, nilai: v.nilai };
    var p = {
      id: buatIdPengajuan(), id_karyawan: v.nilai.id_karyawan, jenis: v.nilai.jenis, mulai: v.mulai, selesai: v.selesai,
      alasan: v.nilai.alasan, diajukan: sekarang(), diajukan_oleh: user, status: 'Menunggu',
      diproses_oleh: null, diproses_pada: null, alasan_penolakan: ''
    };
    D().pengajuan.push(p); save();
    return { p: p, nama: cariKaryawanSemua(p.id_karyawan).nama };
  };
  function ambilMenunggu(pid) {
    var p = D().pengajuan.filter(function (x) { return x.id === pid; })[0];
    if (!p) return [null, 'Pengajuan tidak ditemukan.'];
    if (p.status !== 'Menunggu') return [null, 'Pengajuan ' + p.id + ' sudah berstatus ' + p.status + ' dan tidak dapat diproses ulang.'];
    return [p, null];
  }
  function catatKeputusan(p, status, user, alasan) {
    p.status = status; p.diproses_oleh = user; p.diproses_pada = sekarang(); p.alasan_penolakan = alasan || '';
    save();
  }
  C.pengajuanSetujui = function (pid, user) {
    var r = ambilMenunggu(pid), p = r[0], err = r[1], k = null;
    if (!err) {
      k = cariKaryawanSemua(p.id_karyawan);
      var b = cariBentrok(p.id_karyawan, p.mulai, p.selesai, ['Disetujui'], p.id);
      if (!k || k.dihapus || k.status === 'Nonaktif') err = 'Karyawan sudah Nonaktif/dihapus, pengajuan tidak dapat disetujui. Tolak pengajuan ini bila perlu.';
      else if (b) err = 'Bertabrakan dengan pengajuan ' + b.id + ' yang sudah disetujui.';
    }
    if (err) return { err: err };
    catatKeputusan(p, 'Disetujui', user);
    return { p: p, k: k };
  };
  C.pengajuanTolak = function (pid, alasanMentah, user) {
    var alasan = squash(alasanMentah);
    var r = ambilMenunggu(pid), p = r[0];
    if (r[1]) return { err: r[1] };
    var pesan = !alasan ? 'Alasan penolakan wajib diisi.' : len(alasan) > ALASAN_MAKS ? 'Alasan penolakan maksimal ' + ALASAN_MAKS + ' karakter.' : '';
    if (pesan) return { modalError: pesan, id: p.id, alasan: alasan };
    catatKeputusan(p, 'Ditolak', user, alasan);
    return { p: p, nama: cariKaryawanSemua(p.id_karyawan).nama };
  };

  // ---------- LAPORAN ABSENSI ----------
  function rentangPeriode(periode, hariIni) {
    if (periode === 'hari_ini') return [hariIni, hariIni];
    if (periode === 'minggu_ini') { var senin = addDays(hariIni, -weekday(hariIni)); return [senin, addDays(senin, 6)]; }
    var a = hariIni.split('-').map(Number), akhir = new Date(Date.UTC(a[0], a[1], 0)).getUTCDate();
    return [hariIni.slice(0, 8) + '01', hariIni.slice(0, 8) + pad(akhir)];
  }
  C.rentangPeriode = rentangPeriode;

  C.parseFilterLaporan = function (args, hariIni) {
    var errors = [];
    var mDari = String(args.get('dari', '')).trim(), mSampai = String(args.get('sampai', '')).trim();
    var periode = String(args.get('periode', '')).trim();
    if (!(periode in NAMA_PERIODE)) periode = (mDari || mSampai) ? 'rentang' : 'bulan_ini';
    var dari, sampai;
    if (periode === 'rentang') {
      sampai = mSampai ? parseTanggal(mSampai) : hariIni;
      if (sampai === null) { errors.push('Format tanggal selesai tidak valid.'); sampai = hariIni; }
      dari = mDari ? parseTanggal(mDari) : sampai.slice(0, 8) + '01';
      if (dari === null) { errors.push('Format tanggal mulai tidak valid.'); dari = sampai.slice(0, 8) + '01'; }
      if (!errors.length) {
        if (dari > sampai) errors.push('Tanggal selesai tidak boleh lebih awal daripada tanggal mulai.');
        else if (diffDays(sampai, dari) + 1 > RENTANG_MAKS_HARI) errors.push('Rentang tanggal maksimal ' + RENTANG_MAKS_HARI + ' hari.');
      }
    } else { var r = rentangPeriode(periode, hariIni); dari = r[0]; sampai = r[1]; }
    var kid = String(args.get('karyawan', '')).trim();
    if (kid && !cariKaryawanSemua(kid)) { errors.push('Karyawan yang dipilih tidak ditemukan.'); kid = ''; }
    var status = String(args.get('status', '')).trim();
    if (STATUS_LAPORAN.indexOf(status) < 0) status = '';
    var q = squash(args.get('q', '')).slice(0, 100);
    return { f: { periode: periode, dari: dari, sampai: sampai, karyawan: kid, status: status, q: q }, errors: errors };
  };

  function bangunLaporan(karyawan, log, f, hariIni, pengajuan) {
    var kw = f.q.toLowerCase();
    var kar = karyawan.filter(function (k) {
      return (!f.karyawan || k.id === f.karyawan) && (!kw || k.id.toLowerCase().indexOf(kw) >= 0 || k.nama.toLowerCase().indexOf(kw) >= 0);
    });
    var semua = bangunRiwayat(kar, log, f.dari, f.sampai, hariIni, '', '', pengajuan);
    var relevan = {};
    semua.forEach(function (r) { relevan[r.id] = 1; });
    kar.forEach(function (k) { if ((k.status === 'Aktif' || k.status === 'Cuti') && !k.dihapus) relevan[k.id] = 1; });
    semua.forEach(function (r) { r.label = r.status === 'Tepat Waktu' ? 'Hadir' : r.status; });
    var rows;
    if (f.status === 'Hadir') rows = semua.filter(function (r) { return r.datang !== null; });
    else if (f.status) rows = semua.filter(function (r) { return r.status === f.status; });
    else rows = semua;
    return [rows, Object.keys(relevan).length];
  }
  C.bangunLaporan = bangunLaporan;

  function unik(rows) { var s = {}; rows.forEach(function (r) { s[r.id] = 1; }); return Object.keys(s).length; }
  C.statistikLaporan = function (rows, totalKaryawan) {
    var hadir = rows.filter(function (r) { return r.datang !== null; });
    var terlambat = rows.filter(function (r) { return r.status === 'Terlambat'; });
    var tidak = rows.filter(function (r) { return r.status === 'Tidak Hadir'; });
    var jumlah = {};
    STATUS_LAPORAN.forEach(function (s) { jumlah[s] = rows.filter(function (r) { return r.label === s; }).length; });
    var total = rows.length;
    return {
      karyawan: totalKaryawan, hadir: hadir.length, hadir_unik: unik(hadir), terlambat: terlambat.length, terlambat_unik: unik(terlambat),
      tidak_hadir: tidak.length, tidak_hadir_unik: unik(tidak), izin: jumlah.Izin, cuti: jumlah.Cuti, total_baris: total,
      distribusi: STATUS_LAPORAN.map(function (s) { return { label: s, jumlah: jumlah[s], persen: total ? jumlah[s] * 100 / total : 0 }; })
    };
  };
  C.dataTren = function (rows, f, hariIni) {
    var tren = { label: [], penuh: [], hadir: [], terlambat: [] };
    if (!rows.length) return tren;
    var perHari = {};
    rows.forEach(function (r) {
      var d = perHari[r.tanggal] = perHari[r.tanggal] || [0, 0];
      if (r.datang !== null) d[0]++;
      if (r.status === 'Terlambat') d[1]++;
    });
    var hari = f.dari, batas = f.sampai < hariIni ? f.sampai : hariIni;
    while (hari <= batas) {
      if (HARI_KERJA.indexOf(weekday(hari)) >= 0 || hari in perHari) {
        var v = perHari[hari] || [0, 0], a = hari.split('-').map(Number);
        tren.label.push(a[2] + ' ' + NAMA_BULAN[a[1] - 1].slice(0, 3));
        tren.penuh.push(formatTanggalPendek(hari));
        tren.hadir.push(v[0]); tren.terlambat.push(v[1]);
      }
      hari = addDays(hari, 1);
    }
    return tren;
  };
  C.argsLaporan = function (f) {
    var a = { periode: f.periode, karyawan: f.karyawan || null, status: f.status || null, q: f.q || null };
    if (f.periode === 'rentang') { a.dari = f.dari; a.sampai = f.sampai; }
    return a;
  };
  C.pilihanKaryawanLaporan = function () {
    var punyaLog = {}; D().log.forEach(function (r) { punyaLog[r.id_karyawan] = 1; });
    var hasil = [];
    D().karyawan.slice().sort(function (a, b) { var x = a.nama.toLowerCase(), y = b.nama.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; })
      .forEach(function (k) {
        if (k.dihapus && !punyaLog[k.id]) return;
        var ak = k.dihapus ? ' — Dihapus' : k.status === 'Nonaktif' ? ' — Nonaktif' : '';
        hasil.push({ id: k.id, label: k.nama + ' (' + k.id + ')' + ak });
      });
    return hasil;
  };
  C.konteksLaporan = function (args) {
    var hariIni = C.hariIni(), pf = C.parseFilterLaporan(args, hariIni), f = pf.f, errors = pf.errors;
    var r = errors.length ? [[], 0] : bangunLaporan(D().karyawan, D().log, f, hariIni, D().pengajuan);
    return { hariIni: hariIni, f: f, errors: errors, rows: r[0], stats: C.statistikLaporan(r[0], r[1]), tren: C.dataTren(r[0], f, hariIni) };
  };
  C.ringkasanFilter = function (f) {
    var k = f.karyawan ? cariKaryawanSemua(f.karyawan) : null;
    return [
      ['Periode', NAMA_PERIODE[f.periode] + ': ' + formatRentang(f.dari, f.sampai)],
      ['Karyawan', k ? k.nama + ' (' + k.id + ')' : 'Semua Karyawan'],
      ['Status', f.status || 'Semua Status'],
      ['Pencarian', f.q || '-']
    ];
  };
  function jamAtauStrip(w) { return w !== null ? hhmm(w) : '-'; }
  C.jamAtauStrip = jamAtauStrip;
  C.csvLaporan = function (f, rows, stats, waktu) {
    var out = [['Laporan Absensi']];
    C.ringkasanFilter(f).forEach(function (r) { out.push(r); });
    out.push(['Diekspor pada', waktu], ['Total Karyawan', stats.karyawan], ['Total Hadir (karyawan x hari)', stats.hadir],
      ['Total Terlambat', stats.terlambat], ['Total Tidak Hadir', stats.tidak_hadir], ['Izin', stats.izin], ['Cuti', stats.cuti], [], KOLOM_LAPORAN);
    rows.forEach(function (r, i) {
      out.push([i + 1, r.tanggal, selCsv(r.id), selCsv(r.nama), selCsv(r.jabatan), jamAtauStrip(r.datang), jamAtauStrip(r.pulang), r.label, selCsv(r.keterangan)]);
    });
    return csvText(out);
  };

  return C;
});
