/* UI Sistem Absensi (statis, untuk GitHub Pages). Routing berbasis hash: #/dashboard, #/karyawan?q=..&page=2 dst.
   Semua logika ada di core.js; data tersimpan di localStorage browser ini. */
(function () {
  'use strict';
  var Core = window.Core;
  var APP = document.getElementById('app');
  var USER_KEY = 'absensi_user_v1';

  // ---------- util ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function sel(cond, txt) { return cond ? txt : ''; }
  function qs(obj) {
    var p = new URLSearchParams();
    Object.keys(obj).forEach(function (k) { if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') p.set(k, obj[k]); });
    var s = p.toString();
    return s ? '?' + s : '';
  }
  function href(path, obj) { return '#/' + path + qs(obj || {}); }
  function merge(a, b) { return Object.assign({}, a, b); }
  function getUser() { try { return localStorage.getItem(USER_KEY); } catch (e) { return null; } }
  function setUser(u) { try { if (u) localStorage.setItem(USER_KEY, u); else localStorage.removeItem(USER_KEY); } catch (e) {} }
  function isAdmin() { return Core.ADMIN_USERS.indexOf(getUser()) >= 0; }
  function formObj(form) {
    var o = {}; new FormData(form).forEach(function (v, k) { o[k] = v; }); return o;
  }
  function argsOf(query) { return { get: function (k, d) { return query.has(k) ? query.get(k) : (d === undefined ? '' : d); } }; }

  // pesan flash (seperti Flask): tampil sekali di halaman berikutnya yang menampilkannya
  var flashes = [];
  function flash(cat, msg) { flashes.push([cat, msg]); }
  function takeFlashes() { var f = flashes; flashes = []; return f; }
  function flashHTML(cls, extra) {
    return takeFlashes().map(function (f) {
      return '<div class="alert alert-' + esc(f[0]) + (cls ? ' ' + cls : '') + '"' + (extra === undefined ? ' role="status"' : extra) + '>' + esc(f[1]) + '</div>';
    }).join('');
  }

  var refocus = null;   // id input yang difokuskan lagi setelah render (pencarian otomatis)
  var chartObserver = null;

  // ---------- navigasi ----------
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, ''), i = h.indexOf('?');
    var path = (i < 0 ? h : h.slice(0, i)).replace(/\/$/, '');
    return { path: path, query: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
  }
  function navigate(h, replace) {
    if (location.hash === h) { render(); return; }
    if (replace) location.replace(h); else location.hash = h;
  }

  // ---------- layout ----------
  function layout(active, mainClass, content) {
    function a(key, label) {
      return '<a href="' + href(key) + '" class="' + (active === key ? 'active' : '') + '">' + label + '</a>';
    }
    return '<div class="layout"><aside class="sidebar"><div class="brand">Attendance<br>System</div><nav>' +
      a('dashboard', 'Dashboard') + a('karyawan', 'Data Karyawan') + a('absensi', 'Absensi') + a('riwayat', 'Riwayat') +
      a('pengajuan', 'Pengajuan') + a('laporan', 'Laporan') +
      '<a href="#/logout">Logout</a></nav></aside><main class="content ' + esc(mainClass || '') + '">' + content + '</main></div>';
  }

  function paginationHTML(page, jumlahHal, halaman, linkFn) {
    var h = '<nav class="pagination" aria-label="Pagination">';
    h += page > 1 ? '<a href="' + linkFn(page - 1) + '" aria-label="Sebelumnya">‹</a>' : '<a class="disabled" aria-disabled="true" aria-label="Sebelumnya">‹</a>';
    halaman.forEach(function (n) {
      if (n === null) h += '<a class="gap">…</a>';
      else h += '<a href="' + linkFn(n) + '" class="' + (n === page ? 'active' : '') + '"' + (n === page ? ' aria-current="page"' : '') + '>' + n + '</a>';
    });
    h += page < jumlahHal ? '<a href="' + linkFn(page + 1) + '" aria-label="Berikutnya">›</a>' : '<a class="disabled" aria-disabled="true" aria-label="Berikutnya">›</a>';
    return h + '</nav>';
  }

  function badgeRiwayat(st) {
    return st === 'Tepat Waktu' ? 'badge-green' : st === 'Terlambat' ? 'badge-orange' : (st === 'Cuti' || st === 'Izin') ? 'badge-blue' : 'badge-red';
  }
  function badgeLaporan(l) {
    return l === 'Hadir' ? 'badge-green' : l === 'Terlambat' ? 'badge-orange' : l === 'Izin' ? 'badge-blue' : l === 'Cuti' ? 'badge-purple' : 'badge-red';
  }

  function download(nama, blobParts, mime) {
    var blob = new Blob(blobParts, { type: mime });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nama; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function bindDialogs(dialogs) {
    dialogs.filter(Boolean).forEach(function (d) {
      $$('[data-tutup]', d).forEach(function (b) { b.addEventListener('click', function () { d.close(); }); });
      d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    });
  }
  function bersih(d) {
    $$('.field-error', d).forEach(function (e) { e.remove(); });
    $$('.has-error', d).forEach(function (e) { e.classList.remove('has-error'); });
  }
  // cegah kirim ganda: tombol submit dinonaktifkan sesaat setelah ditekan
  function lockSubmit(form) {
    form.addEventListener('submit', function (e) {
      var b = e.submitter || form.querySelector('button[type=submit]');
      if (!b) return;
      b.dataset.teks = b.textContent; b.textContent = 'Memproses…';
      setTimeout(function () { b.disabled = true; }, 0);
    }, true);
  }

  // =====================================================================
  // LOGIN
  // =====================================================================
  function vLogin() {
    var html = '<div class="login-wrap"><form class="login-card" id="form-login">' +
      '<div class="login-icon">👥</div><h1>Attendance System</h1><p class="muted">Silakan login untuk melanjutkan</p>' +
      flashHTML('', '') +
      '<label for="username">Username</label><input type="text" id="username" name="username" placeholder="Masukkan username Anda" required>' +
      '<label for="password">Password</label><input type="password" id="password" name="password" placeholder="Masukkan password Anda" required>' +
      '<div class="row-between"><label class="check"><input type="checkbox" name="remember"> Ingat Saya</label><a href="#/login" class="link">Lupa Password?</a></div>' +
      '<button type="submit" class="btn btn-primary btn-block">Login</button>' +
      '<p class="muted small center">© 2024 Attendance System</p></form></div>';
    return {
      title: 'Login - Sistem Absensi', bare: true, html: html,
      after: function () {
        $('#form-login').addEventListener('submit', function (e) {
          e.preventDefault();
          var o = formObj(e.target);
          if (Object.prototype.hasOwnProperty.call(Core.USERS, o.username) && Core.USERS[o.username] === o.password) {
            setUser(o.username); navigate('#/dashboard');
          } else { flash('error', 'Username atau password salah'); render(); }
        });
      }
    };
  }

  // =====================================================================
  // DASHBOARD
  // =====================================================================
  function vDashboard() {
    var db = Core.getDB(), hari = Core.hariIni();
    var s = Core.hitungStatistik(db.karyawan, db.log, hari, db.pengajuan);
    var logs = Core.logTerbaru(db.karyawan, db.log);
    var rows = logs.map(function (l) {
      return '<tr><td>' + esc(l.nama) + '</td><td>' + esc(l.waktu) +
        (l.tanggal !== hari ? ' <span class="muted small">(' + l.tanggal.slice(8, 10) + '/' + l.tanggal.slice(5, 7) + ')</span>' : '') +
        '</td><td>' + esc(l.jenis) + '</td><td><span class="badge ' +
        (l.status === 'Tepat Waktu' ? 'badge-green' : l.status === 'Terlambat' ? 'badge-orange' : 'badge-red') + '">' + esc(l.status) + '</span></td></tr>';
    }).join('') || '<tr><td colspan="4" class="center muted">Belum ada catatan absensi</td></tr>';
    var html = '<header class="page-head"><div><h2>Overview Dashboard</h2><p class="muted">Ringkasan data absensi hari ini</p></div>' +
      '<div class="date-box">' + esc(Core.formatTanggalId(hari)) + '</div></header>' +
      '<section class="stats">' +
      '<div class="stat-card"><span class="muted small">Total Karyawan</span><strong>' + num(s.total) + '</strong><span class="muted small">orang</span></div>' +
      '<div class="stat-card"><span class="muted small">Hadir</span><strong>' + num(s.hadir) + '</strong><span class="text-green small">' + s.persen_hadir + '%</span></div>' +
      '<div class="stat-card"><span class="muted small">Terlambat</span><strong>' + num(s.terlambat) + '</strong><span class="text-orange small">' + s.persen_terlambat + '%</span></div>' +
      '<div class="stat-card"><span class="muted small">Tidak Hadir</span><strong>' + num(s.tidak_hadir) + '</strong><span class="text-red small">' + s.persen_tidak_hadir + '%</span></div>' +
      '</section><section class="grid-2"><div class="card"><div class="row-between"><h3>Log Absensi Terbaru</h3>' +
      '<a href="' + href('riwayat') + '" class="link small">Lihat Semua</a></div><table class="table"><thead><tr><th>Nama</th><th>Waktu</th><th>Jenis</th><th>Status</th></tr></thead><tbody>' +
      rows + '</tbody></table></div><div class="card"><h3>Pemberitahuan</h3><p class="muted small">Belum ada pemberitahuan.</p></div></section>';
    return { title: 'Dashboard Admin - Sistem Absensi', active: 'dashboard', html: html };
  }

  // =====================================================================
  // DATA KARYAWAN
  // =====================================================================
  function fieldHTML(form, name, label, type, vals, errs) {
    return '<label for="' + form + '-' + name + '">' + label + '</label><input type="' + type + '" id="' + form + '-' + name + '" name="' + name +
      '" value="' + esc(vals[name] || '') + '" required maxlength="' + (name === 'email' ? 254 : 100) + '" class="' + (errs[name] ? 'has-error' : '') + '">' +
      (errs[name] ? '<p class="field-error">' + esc(errs[name]) + '</p>' : '');
  }

  function vKaryawan(query, modal) {
    var q = query.get('q') || '', page = Core.intArg(query.get('page') || 1, 1);
    var d = Core.daftarKaryawan(q, page);
    q = d.q; page = d.page;
    var mAdd = modal && modal.mode === 'tambah' ? modal : null, mEdit = modal && modal.mode === 'edit' ? modal : null;
    var link = function (n) { return href('karyawan', { q: q || null, page: n > 1 ? n : null }); };
    var rows = d.data.map(function (k) {
      return '<tr><td>' + esc(k.id) + '</td><td>' + esc(k.nama) + '</td><td>' + esc(k.jabatan) + '</td><td>' + esc(k.email) + '</td><td>' + esc(k.hp) + '</td>' +
        '<td><span class="badge ' + (k.status === 'Aktif' ? 'badge-green' : k.status === 'Cuti' ? 'badge-orange' : 'badge-red') + '">' + esc(k.status) + '</span></td>' +
        '<td class="actions"><button type="button" class="icon-btn btn-edit" title="Edit" aria-label="Edit ' + esc(k.nama) + '" data-id="' + esc(k.id) + '" data-nama="' + esc(k.nama) +
        '" data-email="' + esc(k.email) + '" data-hp="' + esc(k.hp) + '" data-jabatan="' + esc(k.jabatan) + '" data-status="' + esc(k.status) + '">✏️</button>' +
        '<button type="button" class="icon-btn btn-hapus" title="Hapus" aria-label="Hapus ' + esc(k.nama) + '" data-id="' + esc(k.id) + '" data-nama="' + esc(k.nama) + '">🗑️</button></td></tr>';
    }).join('') || '<tr><td colspan="7" class="center muted">' + (q ? 'Data karyawan tidak ditemukan' : 'Belum ada data karyawan') + '</td></tr>';
    var addV = mAdd ? mAdd.nilai : {}, addE = mAdd ? mAdd.errors : {};
    var edV = mEdit ? mEdit.nilai : {}, edE = mEdit ? mEdit.errors : {};
    var html = '<header class="page-head"><h2>Data Karyawan</h2></header>' + flashHTML() +
      '<div class="card table-card"><div class="row-between"><form id="form-cari"><input type="search" name="q" id="input-cari" class="search" placeholder="Cari karyawan..." value="' + esc(q) + '" autocomplete="off"></form>' +
      '<button type="button" class="btn btn-primary" id="btn-tambah">+ Tambah Karyawan</button></div>' +
      '<div class="table-scroll"><table class="table"><thead><tr><th>ID</th><th>Nama</th><th>Jabatan</th><th>Email</th><th>No. HP</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="row-between"><span class="muted small">' + (d.jumlahHal > 1 ? 'Menampilkan ' + d.awal + '–' + d.akhir + ' dari ' + d.total + ' data' : 'Menampilkan ' + d.total + ' data') + '</span>' +
      paginationHTML(page, d.jumlahHal, d.halaman, link) + '</div></div>' +
      '<dialog id="dlg-tambah" class="modal"><form id="form-tambah"><h3>Tambah Karyawan</h3><p class="muted small">ID dibuat otomatis dan status awal adalah Aktif.</p>' +
      fieldHTML('add', 'nama', 'Nama lengkap', 'text', addV, addE) + fieldHTML('add', 'email', 'Email', 'email', addV, addE) +
      fieldHTML('add', 'hp', 'Nomor HP', 'tel', addV, addE) + fieldHTML('add', 'jabatan', 'Jabatan', 'text', addV, addE) +
      '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-primary">Simpan</button></div></form></dialog>' +
      '<dialog id="dlg-edit" class="modal"><form id="form-edit" data-kid="' + esc(mEdit ? mEdit.id : '') + '"><h3>Edit Karyawan</h3>' +
      fieldHTML('edit', 'nama', 'Nama lengkap', 'text', edV, edE) + fieldHTML('edit', 'email', 'Email', 'email', edV, edE) +
      fieldHTML('edit', 'hp', 'Nomor HP', 'tel', edV, edE) + fieldHTML('edit', 'jabatan', 'Jabatan', 'text', edV, edE) +
      '<label for="edit-status">Status</label><select id="edit-status" name="status" required class="' + (mEdit && mEdit.errors.status ? 'has-error' : '') + '">' +
      Core.STATUS_KARYAWAN.map(function (s) { return '<option value="' + s + '"' + sel(mEdit && mEdit.nilai.status === s, ' selected') + '>' + s + '</option>'; }).join('') + '</select>' +
      (mEdit && mEdit.errors.status ? '<p class="field-error">' + esc(mEdit.errors.status) + '</p>' : '') +
      '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-primary">Simpan Perubahan</button></div></form></dialog>' +
      '<dialog id="dlg-hapus" class="modal"><form id="form-hapus" data-kid=""><h3>Hapus Karyawan?</h3>' +
      '<p>Data karyawan <strong id="hapus-nama"></strong> (<span id="hapus-id"></span>) akan dihapus dari daftar.</p><p class="muted small">Riwayat absensi karyawan ini tetap tersimpan.</p>' +
      '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-danger">Ya, Hapus</button></div></form></dialog>';

    function kembali(qq, pp) { navigate(href('karyawan', { q: qq || null, page: pp && pp > 1 ? pp : null })); }
    return {
      title: 'Data Karyawan - Sistem Absensi', active: 'karyawan', main: 'content-fit', html: html,
      after: function () {
        var dT = $('#dlg-tambah'), dE = $('#dlg-edit'), dH = $('#dlg-hapus');
        bindDialogs([dT, dE, dH]);
        $('#btn-tambah').addEventListener('click', function () {
          bersih(dT);
          $$('input[type=text], input[type=email], input[type=tel]', dT).forEach(function (i) { i.value = ''; });
          dT.showModal();
        });
        $$('.btn-edit').forEach(function (b) {
          b.addEventListener('click', function () {
            bersih(dE);
            $('#form-edit').dataset.kid = b.dataset.id;
            $('#edit-nama').value = b.dataset.nama; $('#edit-email').value = b.dataset.email; $('#edit-hp').value = b.dataset.hp;
            $('#edit-jabatan').value = b.dataset.jabatan; $('#edit-status').value = b.dataset.status;
            dE.showModal();
          });
        });
        $$('.btn-hapus').forEach(function (b) {
          b.addEventListener('click', function () {
            $('#form-hapus').dataset.kid = b.dataset.id;
            $('#hapus-nama').textContent = b.dataset.nama; $('#hapus-id').textContent = b.dataset.id;
            dH.showModal();
          });
        });
        $('#form-tambah').addEventListener('submit', function (e) {
          e.preventDefault();
          var r = Core.karyawanTambah(formObj(e.target));
          if (r.errors) { render({ mode: 'tambah', nilai: r.nilai, errors: r.errors }); return; }
          flash('success', 'Karyawan ' + r.baru.nama + ' (' + r.baru.id + ') berhasil ditambahkan.');
          kembali('', r.halamanAkhir);
        });
        $('#form-edit').addEventListener('submit', function (e) {
          e.preventDefault();
          var kid = e.target.dataset.kid, r = Core.karyawanEdit(kid, formObj(e.target));
          if (r.tidakAda) { flash('error', 'Karyawan tidak ditemukan.'); kembali(q, page); return; }
          if (r.errors) { render({ mode: 'edit', id: kid, nilai: r.nilai, errors: r.errors }); return; }
          flash('success', 'Data ' + r.k.nama + ' (' + r.k.id + ') berhasil diperbarui.');
          kembali(q, page);
        });
        $('#form-hapus').addEventListener('submit', function (e) {
          e.preventDefault();
          var r = Core.karyawanHapus(e.target.dataset.kid);
          if (r.tidakAda) flash('error', 'Karyawan tidak ditemukan atau sudah dihapus.');
          else flash('success', 'Karyawan ' + r.k.nama + ' (' + r.k.id + ') berhasil dihapus.');
          kembali(q, page);
        });
        var timer, input = $('#input-cari');
        $('#form-cari').addEventListener('submit', function (e) { e.preventDefault(); refocus = 'input-cari'; kembali(input.value.trim(), 1); });
        input.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () { refocus = 'input-cari'; kembali(input.value.trim(), 1); }, 400);
        });
        if (modal) (modal.mode === 'tambah' ? dT : dE).showModal();
      }
    };
  }

  // =====================================================================
  // ABSENSI HARIAN
  // =====================================================================
  function vAbsensi() {
    var jd = Core.jadwal(), aktif = Core.karyawanAktifUrut();
    var html = '<header class="page-head"><h2>Absensi Harian</h2></header><div class="stack">' +
      '<section class="card" aria-labelledby="judul-form"><h3 id="judul-form">Form Absensi</h3>' +
      '<p class="muted">Pilih nama Anda, lalu tekan Absen Datang saat tiba atau Absen Pulang saat selesai bekerja. Waktu dicatat otomatis oleh sistem.</p>' +
      '<div class="notif-area" role="status" aria-live="polite">' + flashHTML('', '') + '</div>' +
      '<form id="form-absen" class="absen-form"><label for="id_karyawan">Nama karyawan</label>' +
      '<select id="id_karyawan" name="id_karyawan" required><option value="">Pilih nama karyawan…</option>' +
      aktif.map(function (k) { return '<option value="' + esc(k.id) + '">' + esc(k.nama) + ' (' + esc(k.id) + ')</option>'; }).join('') + '</select>' +
      (aktif.length ? '' : '<p class="field-error">Belum ada karyawan berstatus Aktif. Tambahkan atau aktifkan karyawan di menu Data Karyawan.</p>') +
      '<div class="absen-actions"><button type="submit" class="btn btn-primary" data-aksi="datang">Absen Datang</button>' +
      '<button type="submit" class="btn btn-dark" data-aksi="pulang">Absen Pulang</button></div></form></section>' +
      '<section class="card" aria-labelledby="judul-jadwal"><h3 id="judul-jadwal">Informasi Jadwal Absensi</h3><div class="jadwal-grid">' +
      '<div class="jadwal-item"><h4>Jadwal Absen Datang</h4><ul class="jadwal-list"><li><span>Waktu mulai</span><strong>' + jd.mulai_datang + ' WIB</strong></li>' +
      '<li><span>Batas tepat waktu</span><strong>' + jd.batas_tepat + ' WIB</strong></li></ul>' +
      '<p class="small"><span class="badge badge-green">Tepat Waktu</span> jika absen sampai pukul ' + jd.batas_tepat + ' WIB.</p>' +
      '<p class="small"><span class="badge badge-orange">Terlambat</span> jika absen setelah pukul ' + jd.batas_tepat + ' WIB.</p></div>' +
      '<div class="jadwal-item"><h4>Jadwal Absen Pulang</h4><ul class="jadwal-list"><li><span>Waktu mulai</span><strong>' + jd.mulai_pulang + ' WIB</strong></li></ul>' +
      '<p class="small muted">Karyawan wajib melakukan absen datang terlebih dahulu.</p>' +
      '<p class="small muted">Setiap karyawan hanya dapat melakukan satu kali absen pulang per hari.</p></div></div></section></div>';
    return {
      title: 'Absensi Harian - Sistem Absensi', active: 'absensi', html: html,
      after: function () {
        var form = $('#form-absen');
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var aksi = e.submitter ? e.submitter.dataset.aksi : 'datang';
          // waktu SELALU dari sistem (jam perangkat), bukan input pengguna
          var r = (aksi === 'pulang' ? Core.catatAbsenPulang : Core.catatAbsenDatang)(form.id_karyawan.value.trim(), Core.sekarang());
          flash(r[0], r[1]);
          render();
        });
      }
    };
  }

  // =====================================================================
  // RIWAYAT
  // =====================================================================
  function vRiwayat(query) {
    var hariIni = Core.hariIni(), pf = Core.parseFilterRiwayat(argsOf(query), hariIni), f = pf.f, errors = pf.errors;
    var db = Core.getDB();
    var rows = errors.length ? [] : Core.bangunRiwayat(db.karyawan, db.log, f.dari, f.sampai, hariIni, f.q, f.status, db.pengajuan);
    var total = rows.length, per = Core.PER_PAGE_RIWAYAT, jumlahHal = Math.max(1, Math.ceil(total / per));
    var page = Math.min(Math.max(Core.intArg(query.get('page') || 1, 1) || 1, 1), jumlahHal);
    var mulai = (page - 1) * per, data = rows.slice(mulai, mulai + per), awal = data.length ? mulai + 1 : 0, akhir = mulai + data.length;
    var st = Core.statistikRiwayat(rows), satuHari = f.dari === f.sampai, args = Core.argsFilterRiwayat(f);
    var link = function (n) { return href('riwayat', merge(args, { page: n })); };
    var trs = data.map(function (r, i) {
      return '<tr><td>' + (mulai + i + 1) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(r.tanggal)) + '</td><td>' + esc(r.id) + '</td><td>' + esc(r.nama) + '</td><td>' + esc(r.jabatan) +
        '</td><td>' + (r.datang !== null ? Core.hhmm(r.datang) : '—') + '</td><td>' + (r.pulang !== null ? Core.hhmm(r.pulang) : '—') +
        '</td><td><span class="badge ' + badgeRiwayat(r.status) + '">' + esc(r.status) + '</span></td><td class="muted">' + esc(r.keterangan) + '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="center muted">Belum ada riwayat absensi pada periode ini</td></tr>';
    var html = '<header class="page-head page-head-col"><h2>Riwayat Absensi</h2><p class="muted">Riwayat kehadiran karyawan ' +
      (satuHari ? 'pada ' + esc(Core.formatTanggalPendek(f.dari)) + '.' : 'periode ' + esc(Core.formatTanggalPendek(f.dari)) + ' – ' + esc(Core.formatTanggalPendek(f.sampai)) + '. Angka ringkasan dihitung per karyawan per hari, bukan karyawan unik.') +
      '</p></header><section class="stats stats-3">' +
      '<div class="stat-card"><span class="muted small">Total Hadir</span><strong>' + num(st.hadir) + '</strong><span class="text-green small">' + (satuHari ? 'orang' : 'kehadiran') + '</span></div>' +
      '<div class="stat-card"><span class="muted small">Terlambat</span><strong>' + num(st.terlambat) + '</strong><span class="text-orange small">' + (satuHari ? 'orang' : 'kehadiran') + '</span></div>' +
      '<div class="stat-card"><span class="muted small">Tidak Hadir</span><strong>' + num(st.tidak_hadir) + '</strong><span class="text-red small">' + (satuHari ? 'orang' : 'karyawan × hari') + '</span></div></section>' +
      '<section class="card filter-card" aria-label="Filter riwayat"><form id="form-filter" class="filter-grid">' +
      '<div class="filter-field filter-q"><label for="f-q">Cari karyawan</label><input type="search" id="f-q" name="q" value="' + esc(f.q) + '" placeholder="Cari nama atau ID karyawan..." autocomplete="off" maxlength="100"></div>' +
      '<div class="filter-field"><label for="f-dari">Dari Tanggal</label><input type="date" id="f-dari" name="dari" value="' + f.dari + '" max="' + f.sampai + '"></div>' +
      '<div class="filter-field"><label for="f-sampai">Sampai Tanggal</label><input type="date" id="f-sampai" name="sampai" value="' + f.sampai + '" min="' + f.dari + '"></div>' +
      '<div class="filter-field"><label for="f-status">Status</label><select id="f-status" name="status"><option value="">Semua Status</option>' +
      Core.STATUS_RIWAYAT.map(function (s) { return '<option value="' + s + '"' + sel(f.status === s, ' selected') + '>' + s + '</option>'; }).join('') + '</select></div>' +
      '<div class="filter-actions"><button type="submit" class="btn btn-primary">Terapkan</button><a href="#/riwayat" class="btn btn-outline">Reset Filter</a></div></form>' +
      errors.map(function (e) { return '<div class="alert alert-error" role="alert">' + esc(e) + '</div>'; }).join('') + flashHTML() + '</section>' +
      '<section class="card table-card" aria-labelledby="judul-daftar"><div class="row-between daftar-head"><div><h3 id="judul-daftar">Daftar Riwayat Absensi</h3><span class="muted small">' +
      (total ? 'Menampilkan ' + awal + '–' + akhir + ' dari ' + total + ' data' : 'Menampilkan 0 data') + '</span></div>' +
      '<a class="btn btn-outline" href="#" id="btn-export">Export CSV</a></div>' +
      '<div class="table-scroll scroll-riwayat"><table class="table table-riwayat"><thead><tr><th>No.</th><th>Tanggal</th><th>ID Karyawan</th><th>Nama Karyawan</th><th>Jabatan</th><th>Jam Datang</th><th>Jam Pulang</th><th>Status</th><th>Keterangan</th></tr></thead><tbody>' +
      trs + '</tbody></table></div><div class="row-between"><span class="muted small">Jam dalam WIB</span>' + paginationHTML(page, jumlahHal, Core.daftarHalaman(page, jumlahHal), link) + '</div></section>';
    return {
      title: 'Riwayat Absensi - Sistem Absensi', active: 'riwayat', main: 'content-fit content-fit-auto', html: html,
      after: function () {
        var form = $('#form-filter'), dari = $('#f-dari'), sampai = $('#f-sampai'), q = $('#f-q'), timer;
        dari.addEventListener('change', function () { if (dari.value) sampai.min = dari.value; });
        sampai.addEventListener('change', function () { if (sampai.value) dari.max = sampai.value; });
        function kirim() {
          if (q === document.activeElement) refocus = 'f-q';
          var o = formObj(form); navigate(href('riwayat', o));
        }
        form.addEventListener('submit', function (e) { e.preventDefault(); kirim(); });
        [dari, sampai, $('#f-status')].forEach(function (el) { el.addEventListener('change', kirim); });
        q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(kirim, 400); });
        $('#btn-export').addEventListener('click', function (e) {
          e.preventDefault();
          var all = Core.bangunRiwayat(db.karyawan, db.log, f.dari, f.sampai, hariIni, f.q, f.status, db.pengajuan);
          download('riwayat_absensi_' + f.dari + '_' + f.sampai + '.csv', [Core.csvRiwayat(all)], 'text/csv;charset=utf-8');
        });
      }
    };
  }

  // =====================================================================
  // PENGAJUAN IZIN & CUTI
  // =====================================================================
  function vPengajuan(query, modal) {
    var db = Core.getDB(), pf = Core.parseFilterPengajuan(argsOf(query)), f = pf.f, errors = pf.errors;
    var rows = errors.length ? [] : Core.bangunPengajuan(db.pengajuan, db.karyawan, f);
    var ring = Core.ringkasanPengajuan(), admin = isAdmin();
    var qstr = qs(Core.argsPengajuan(f)).replace(/^\?/, '');
    var detail = {}; rows.forEach(function (r) { detail[r.id] = Core.detailPengajuan(r); });
    var filterAktif = !!(f.q || f.jenis || f.status || f.dari || f.sampai);
    var aktif = Core.karyawanAktifUrut();
    var mB = modal && modal.mode === 'buat' ? modal : null, mT = modal && modal.mode === 'tolak' ? modal : null;
    var bv = mB ? mB.nilai : {}, be = mB ? mB.errors : {};

    var trs = rows.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.id_karyawan) + '</td><td>' + esc(r.nama) +
        ((r.karyawan_status === 'Nonaktif' || r.karyawan_status === 'Dihapus') ? ' <span class="muted small">(' + r.karyawan_status + ')</span>' : '') +
        '</td><td>' + esc(r.jenis) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(r.mulai)) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(r.selesai)) +
        '</td><td class="cell-alasan" title="' + esc(r.alasan) + '">' + esc(r.alasan) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(Core.dateOf(r.diajukan))) +
        '</td><td><span class="badge ' + (r.status === 'Disetujui' ? 'badge-green' : r.status === 'Ditolak' ? 'badge-red' : 'badge-orange') + '">' + esc(r.status) + '</span></td><td class="actions">' +
        (admin && r.status === 'Menunggu'
          ? '<button type="button" class="btn btn-sm btn-success btn-setuju" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '" data-jenis="' + esc(r.jenis) + '">Setujui</button>' +
            '<button type="button" class="btn btn-sm btn-danger btn-tolak" data-id="' + esc(r.id) + '" data-nama="' + esc(r.nama) + '">Tolak</button>' : '') +
        '<button type="button" class="btn btn-sm btn-outline btn-detail" data-id="' + esc(r.id) + '">Detail</button></td></tr>';
    }).join('') || '<tr><td colspan="10" class="empty-cell"><div class="empty-state"><strong>' + (filterAktif ? 'Tidak ada pengajuan yang cocok' : 'Belum ada pengajuan') + '</strong><span class="muted small">' +
      (filterAktif ? 'Ubah atau reset filter untuk melihat pengajuan lain.' : admin ? 'Klik “+ Buat Pengajuan” untuk mencatat izin atau cuti karyawan.' : 'Pengajuan izin dan cuti akan muncul di sini.') + '</span></div></td></tr>';

    var opts = function (list, cur) { return list.map(function (j) { return '<option value="' + j + '"' + sel(cur === j, ' selected') + '>' + j + '</option>'; }).join(''); };
    var html = '<header class="page-head page-head-col"><h2>Pengajuan Izin &amp; Cuti</h2><p class="muted">Kelola pengajuan izin dan cuti karyawan. Pengajuan yang disetujui memengaruhi perhitungan kehadiran pada rentang tanggalnya.</p></header>' +
      flashHTML('alert-flush') +
      '<section class="stats" aria-label="Ringkasan pengajuan">' +
      '<div class="stat-card"><span class="muted small">Total Pengajuan</span><strong>' + num(ring.total) + '</strong><span class="muted small">pengajuan</span></div>' +
      '<div class="stat-card"><span class="muted small">Menunggu Persetujuan</span><strong>' + num(ring.menunggu) + '</strong><span class="text-orange small">perlu diproses</span></div>' +
      '<div class="stat-card"><span class="muted small">Disetujui</span><strong>' + num(ring.disetujui) + '</strong><span class="text-green small">pengajuan</span></div>' +
      '<div class="stat-card"><span class="muted small">Ditolak</span><strong>' + num(ring.ditolak) + '</strong><span class="text-red small">pengajuan</span></div></section>' +
      '<section class="card filter-card" aria-label="Filter pengajuan"><form id="form-filter" class="filter-grid filter-grid-pgj">' +
      '<div class="filter-field filter-q"><label for="f-q">Cari karyawan</label><input type="search" id="f-q" name="q" value="' + esc(f.q) + '" placeholder="Cari nama atau ID karyawan..." autocomplete="off" maxlength="100"></div>' +
      '<div class="filter-field"><label for="f-jenis">Jenis</label><select id="f-jenis" name="jenis"><option value="">Semua Jenis</option>' + opts(Core.JENIS_PENGAJUAN, f.jenis) + '</select></div>' +
      '<div class="filter-field"><label for="f-status">Status</label><select id="f-status" name="status"><option value="">Semua Status</option>' + opts(Core.STATUS_PENGAJUAN, f.status) + '</select></div>' +
      '<div class="filter-field"><label for="f-dari">Periode dari</label><input type="date" id="f-dari" name="dari" value="' + (f.dari || '') + '"' + (f.sampai ? ' max="' + f.sampai + '"' : '') + '></div>' +
      '<div class="filter-field"><label for="f-sampai">Periode sampai</label><input type="date" id="f-sampai" name="sampai" value="' + (f.sampai || '') + '"' + (f.dari ? ' min="' + f.dari + '"' : '') + '></div>' +
      '<div class="filter-actions"><button type="submit" class="btn btn-primary">Terapkan</button><a href="#/pengajuan" class="btn btn-outline">Reset Filter</a></div></form>' +
      errors.map(function (e) { return '<div class="alert alert-error" role="alert">' + esc(e) + '</div>'; }).join('') + '</section>' +
      '<section class="card table-card" aria-labelledby="judul-daftar"><div class="row-between daftar-head"><div><h3 id="judul-daftar">Daftar Pengajuan</h3><span class="muted small">' +
      (filterAktif ? 'Menampilkan ' + rows.length + ' dari ' + ring.total + ' pengajuan' : 'Menampilkan ' + rows.length + ' pengajuan') + '</span></div>' +
      (admin ? '<button type="button" class="btn btn-primary" id="btn-buat">+ Buat Pengajuan</button>' : '') + '</div>' +
      '<div class="table-scroll scroll-pengajuan"><table class="table table-pengajuan"><thead><tr><th>No.</th><th>ID Karyawan</th><th>Nama Karyawan</th><th>Jenis Pengajuan</th><th>Tanggal Mulai</th><th>Tanggal Selesai</th><th>Alasan</th><th>Tanggal Pengajuan</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' +
      trs + '</tbody></table></div><div class="row-between"><span class="muted small">Terbaru di atas. Tanggal dalam WIB.</span></div></section>';

    if (admin) {
      html += '<dialog id="dlg-buat" class="modal"><form id="form-buat"><h3>Buat Pengajuan</h3><p class="muted small">Status awal pengajuan adalah Menunggu dan baru berlaku setelah disetujui admin.</p>' +
        '<label for="b-karyawan">Nama karyawan</label><select id="b-karyawan" name="id_karyawan" required class="' + (be.id_karyawan ? 'has-error' : '') + '"><option value="">Pilih nama karyawan…</option>' +
        aktif.map(function (k) { return '<option value="' + esc(k.id) + '"' + sel(bv.id_karyawan === k.id, ' selected') + '>' + esc(k.nama) + ' (' + esc(k.id) + ')</option>'; }).join('') + '</select>' +
        (be.id_karyawan ? '<p class="field-error">' + esc(be.id_karyawan) + '</p>' : '') + (aktif.length ? '' : '<p class="field-error">Belum ada karyawan berstatus Aktif.</p>') +
        '<label for="b-jenis">Jenis pengajuan</label><select id="b-jenis" name="jenis" required class="' + (be.jenis ? 'has-error' : '') + '"><option value="">Pilih jenis…</option>' + opts(Core.JENIS_PENGAJUAN, bv.jenis) + '</select>' +
        (be.jenis ? '<p class="field-error">' + esc(be.jenis) + '</p>' : '') +
        '<div class="form-row-2"><div><label for="b-mulai">Tanggal mulai</label><input type="date" id="b-mulai" name="mulai" required value="' + esc(bv.mulai || '') + '" class="' + (be.mulai ? 'has-error' : '') + '"></div>' +
        '<div><label for="b-selesai">Tanggal selesai</label><input type="date" id="b-selesai" name="selesai" required value="' + esc(bv.selesai || '') + '" class="' + (be.selesai ? 'has-error' : '') + '"></div></div>' +
        (be.mulai ? '<p class="field-error">' + esc(be.mulai) + '</p>' : '') + (be.selesai ? '<p class="field-error">' + esc(be.selesai) + '</p>' : '') +
        '<label for="b-alasan">Alasan pengajuan</label><textarea id="b-alasan" name="alasan" rows="3" required maxlength="500" class="' + (be.alasan ? 'has-error' : '') + '">' + esc(bv.alasan || '') + '</textarea>' +
        (be.alasan ? '<p class="field-error">' + esc(be.alasan) + '</p>' : '') +
        '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-primary" id="btn-kirim">Kirim Pengajuan</button></div></form></dialog>' +
        '<dialog id="dlg-setuju" class="modal"><form id="form-setuju" class="form-sekali" data-id=""><h3>Setujui pengajuan?</h3><p><span id="setuju-info"></span></p>' +
        '<p class="muted small">Setelah disetujui, karyawan tidak dihitung Tidak Hadir pada rentang tanggal pengajuan (bila belum absen). Catatan absensi yang sudah ada tidak diubah.</p>' +
        '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-success">Ya, Setujui</button></div></form></dialog>' +
        '<dialog id="dlg-tolak" class="modal"><form id="form-tolak" class="form-sekali" data-id="' + esc(mT ? mT.id : '') + '"><h3>Tolak pengajuan</h3><p><span id="tolak-info">' + esc(mT ? mT.id : '') + '</span></p>' +
        '<label for="t-alasan">Alasan penolakan</label><textarea id="t-alasan" name="alasan_penolakan" rows="3" required maxlength="500" class="' + (mT ? 'has-error' : '') + '">' + esc(mT ? mT.alasan : '') + '</textarea>' +
        (mT ? '<p class="field-error">' + esc(mT.error) + '</p>' : '') +
        '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Batal</button><button type="submit" class="btn btn-danger">Tolak Pengajuan</button></div></form></dialog>';
    }
    html += '<dialog id="dlg-detail" class="modal modal-lg"><h3>Detail Pengajuan <span id="d-id" class="muted"></span></h3><dl class="detail-list">' +
      '<div><dt>Karyawan</dt><dd id="d-karyawan"></dd></div><div><dt>Jabatan</dt><dd id="d-jabatan"></dd></div><div><dt>Jenis</dt><dd id="d-jenis"></dd></div>' +
      '<div><dt>Periode</dt><dd id="d-periode"></dd></div><div><dt>Durasi</dt><dd id="d-durasi"></dd></div><div><dt>Alasan</dt><dd id="d-alasan" class="pre-wrap"></dd></div>' +
      '<div><dt>Diajukan</dt><dd id="d-diajukan"></dd></div><div><dt>Status</dt><dd><span id="d-status" class="badge"></span></dd></div>' +
      '<div id="d-baris-proses"><dt>Diputuskan</dt><dd id="d-proses"></dd></div><div id="d-baris-tolak"><dt>Alasan penolakan</dt><dd id="d-tolak" class="pre-wrap"></dd></div></dl>' +
      '<div class="modal-actions"><button type="button" class="btn btn-outline" data-tutup>Tutup</button></div></dialog>';

    function kembali() { navigate(href('pengajuan', Core.argsPengajuan(f))); }
    return {
      title: 'Pengajuan Izin & Cuti - Sistem Absensi', active: 'pengajuan', main: 'content-fit content-fit-auto', html: html,
      after: function () {
        var dB = $('#dlg-buat'), dS = $('#dlg-setuju'), dT = $('#dlg-tolak'), dD = $('#dlg-detail');
        bindDialogs([dB, dS, dT, dD]);
        $$('dialog form').forEach(lockSubmit);

        if (dB) {
          var mulai = $('#b-mulai'), selesai = $('#b-selesai');
          $('#btn-buat').addEventListener('click', function () {
            bersih(dB); $('#form-buat').reset(); selesai.min = ''; dB.showModal();
          });
          mulai.addEventListener('change', function () {
            if (!mulai.value) return;
            selesai.min = mulai.value;
            if (!selesai.value || selesai.value < mulai.value) selesai.value = mulai.value;
          });
          $('#form-buat').addEventListener('submit', function (e) {
            e.preventDefault();
            var r = Core.pengajuanBuat(formObj(e.target), getUser());
            if (r.errors) { render({ mode: 'buat', nilai: r.nilai, errors: r.errors }); return; }
            flash('success', 'Pengajuan ' + r.p.jenis + ' ' + r.p.id + ' untuk ' + r.nama + ' berhasil dikirim dan menunggu persetujuan.');
            kembali();
          });
          $$('.btn-setuju').forEach(function (b) {
            b.addEventListener('click', function () {
              $('#form-setuju').dataset.id = b.dataset.id;
              $('#setuju-info').textContent = b.dataset.jenis + ' ' + b.dataset.id + ' atas nama ' + b.dataset.nama + ' akan disetujui.';
              dS.showModal();
            });
          });
          $('#form-setuju').addEventListener('submit', function (e) {
            e.preventDefault();
            var r = Core.pengajuanSetujui(e.target.dataset.id, getUser());
            if (r.err) flash('error', r.err);
            else flash('success', 'Pengajuan ' + r.p.jenis + ' ' + r.p.id + ' (' + r.k.nama + ') disetujui.');
            kembali();
          });
          $$('.btn-tolak').forEach(function (b) {
            b.addEventListener('click', function () {
              bersih(dT);
              $('#form-tolak').dataset.id = b.dataset.id;
              $('#tolak-info').textContent = b.dataset.id + ' atas nama ' + b.dataset.nama;
              $('#t-alasan').value = '';
              dT.showModal();
            });
          });
          $('#form-tolak').addEventListener('submit', function (e) {
            e.preventDefault();
            var r = Core.pengajuanTolak(e.target.dataset.id, e.target.alasan_penolakan.value, getUser());
            if (r.err) { flash('error', r.err); kembali(); return; }
            if (r.modalError) { render({ mode: 'tolak', id: r.id, alasan: r.alasan, error: r.modalError }); return; }
            flash('success', 'Pengajuan ' + r.p.jenis + ' ' + r.p.id + ' (' + r.nama + ') ditolak.');
            kembali();
          });
        }

        $$('.btn-detail').forEach(function (b) {
          b.addEventListener('click', function () {
            var d = detail[b.dataset.id]; if (!d) return;
            $('#d-id').textContent = d.id;
            var kar = d.nama + ' (' + d.id_karyawan + ')';
            if (d.karyawan_status === 'Nonaktif' || d.karyawan_status === 'Dihapus') kar += ' — ' + d.karyawan_status;
            $('#d-karyawan').textContent = kar; $('#d-jabatan').textContent = d.jabatan; $('#d-jenis').textContent = d.jenis;
            $('#d-periode').textContent = d.mulai === d.selesai ? d.mulai : d.mulai + ' s.d. ' + d.selesai;
            $('#d-durasi').textContent = d.durasi; $('#d-alasan').textContent = d.alasan;
            $('#d-diajukan').textContent = d.diajukan + (d.diajukan_oleh !== '—' ? ' oleh ' + d.diajukan_oleh : '');
            var st = $('#d-status'); st.textContent = d.status;
            st.className = 'badge ' + (d.status === 'Disetujui' ? 'badge-green' : d.status === 'Ditolak' ? 'badge-red' : 'badge-orange');
            var proses = d.diproses_pada ? d.diproses_pada + (d.diproses_oleh ? ' oleh ' + d.diproses_oleh : '') : '';
            $('#d-proses').textContent = proses; $('#d-baris-proses').hidden = !proses;
            $('#d-tolak').textContent = d.alasan_penolakan; $('#d-baris-tolak').hidden = !d.alasan_penolakan;
            dD.showModal();
          });
        });

        var form = $('#form-filter'), dari = $('#f-dari'), sampai = $('#f-sampai'), q = $('#f-q'), timer;
        dari.addEventListener('change', function () { if (dari.value) sampai.min = dari.value; });
        sampai.addEventListener('change', function () { if (sampai.value) dari.max = sampai.value; });
        function kirim() { if (q === document.activeElement) refocus = 'f-q'; navigate(href('pengajuan', formObj(form))); }
        form.addEventListener('submit', function (e) { e.preventDefault(); kirim(); });
        [dari, sampai, $('#f-jenis'), $('#f-status')].forEach(function (el) { el.addEventListener('change', kirim); });
        q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(kirim, 400); });

        if (modal) (modal.mode === 'buat' ? dB : dT).showModal();
      }
    };
  }

  // =====================================================================
  // LAPORAN
  // =====================================================================
  function vLaporan(query) {
    var k = Core.konteksLaporan(argsOf(query)), f = k.f, errors = k.errors, rows = k.rows, stats = k.stats, tren = k.tren;
    var total = rows.length, per = Core.PER_PAGE_LAPORAN, jumlahHal = Math.max(1, Math.ceil(total / per));
    var page = Math.min(Math.max(Core.intArg(query.get('page') || 1, 1) || 1, 1), jumlahHal);
    var mulai = (page - 1) * per, data = rows.slice(mulai, mulai + per), awal = data.length ? mulai + 1 : 0, akhir = mulai + data.length;
    var args = Core.argsLaporan(f), filterAktif = !!(f.karyawan || f.status || f.q);
    var link = function (n) { return href('laporan', merge(args, { page: n })); };
    var custom = f.periode === 'rentang';
    var trs = data.map(function (r, i) {
      return '<tr><td>' + (mulai + i + 1) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(r.tanggal)) + '</td><td>' + esc(r.id) + '</td><td>' + esc(r.nama) + '</td><td>' + esc(r.jabatan) +
        '</td><td>' + Core.jamAtauStrip(r.datang) + '</td><td>' + Core.jamAtauStrip(r.pulang) + '</td><td><span class="badge ' + badgeLaporan(r.label) + '">' + esc(r.label) +
        '</span></td><td class="muted">' + esc(r.keterangan || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="empty-cell"><div class="empty-state"><strong>' +
      (filterAktif ? 'Tidak ada data yang cocok dengan filter' : 'Belum ada data laporan pada periode ini') + '</strong><span class="muted small">' +
      (filterAktif ? 'Ubah atau reset filter untuk melihat data lain.' : 'Data akan muncul setelah karyawan melakukan absensi atau pada hari kerja yang sudah berlalu.') + '</span></div></td></tr>';
    var dist = stats.total_baris
      ? '<div class="dist">' + stats.distribusi.map(function (d) {
          return '<div class="dist-row"><span>' + esc(d.label) + '</span><div class="dist-bar"><div class="dist-fill dist-' + d.label.toLowerCase().replace(/ /g, '-') +
            '" style="width: ' + d.persen.toFixed(1) + '%"></div></div><span class="dist-val"><strong>' + d.jumlah + '</strong> <span class="muted">(' + Math.round(d.persen) + '%)</span></span></div>';
        }).join('') + '</div><p class="muted small dist-note">Hadir = tepat waktu. Satuan: karyawan × hari.</p>'
      : '<p class="muted small chart-empty">Belum ada data untuk grafik pada filter ini.</p>';

    var html = '<header class="page-head page-head-col"><h2>Laporan Absensi</h2><p class="muted">Rekap dan analisis kehadiran karyawan</p></header>' +
      '<section class="card filter-card" aria-label="Filter laporan"><form id="form-filter" class="filter-grid filter-grid-lap">' +
      '<div class="filter-field"><label for="f-periode">Periode</label><select id="f-periode" name="periode">' +
      Core.PERIODE_LAPORAN.map(function (p) { return '<option value="' + p[0] + '"' + sel(f.periode === p[0], ' selected') + '>' + p[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="filter-field"><label for="f-dari">Tanggal Mulai</label><input type="date" id="f-dari" name="dari" value="' + f.dari + '" max="' + f.sampai + '"' + (custom ? '' : ' disabled') + '></div>' +
      '<div class="filter-field"><label for="f-sampai">Tanggal Selesai</label><input type="date" id="f-sampai" name="sampai" value="' + f.sampai + '" min="' + f.dari + '"' + (custom ? '' : ' disabled') + '></div>' +
      '<div class="filter-field"><label for="f-karyawan">Karyawan</label><select id="f-karyawan" name="karyawan"><option value="">Semua Karyawan</option>' +
      Core.pilihanKaryawanLaporan().map(function (x) { return '<option value="' + esc(x.id) + '"' + sel(f.karyawan === x.id, ' selected') + '>' + esc(x.label) + '</option>'; }).join('') + '</select></div>' +
      '<div class="filter-field"><label for="f-status">Status Absensi</label><select id="f-status" name="status"><option value="">Semua Status</option>' +
      Core.STATUS_LAPORAN.map(function (s) { return '<option value="' + s + '"' + sel(f.status === s, ' selected') + '>' + s + '</option>'; }).join('') + '</select></div>' +
      '<div class="filter-actions"><button type="submit" class="btn btn-primary">Tampilkan Laporan</button><a href="#/laporan" class="btn btn-outline">Reset Filter</a></div></form>' +
      errors.map(function (e) { return '<div class="alert alert-error" role="alert">' + esc(e) + '</div>'; }).join('') + flashHTML() + '</section>' +
      '<section class="stats" aria-label="Ringkasan laporan">' +
      '<div class="stat-card"><span class="muted small">Total Karyawan</span><strong>' + num(stats.karyawan) + '</strong><span class="muted small">karyawan unik</span></div>' +
      '<div class="stat-card"><span class="muted small">Total Hadir</span><strong>' + num(stats.hadir) + '</strong><span class="text-green small">' + stats.hadir_unik + ' karyawan unik · termasuk terlambat</span></div>' +
      '<div class="stat-card"><span class="muted small">Total Terlambat</span><strong>' + num(stats.terlambat) + '</strong><span class="text-orange small">' + stats.terlambat_unik + ' karyawan unik</span></div>' +
      '<div class="stat-card"><span class="muted small">Total Tidak Hadir</span><strong>' + num(stats.tidak_hadir) + '</strong><span class="text-red small">' + stats.tidak_hadir_unik + ' karyawan unik</span></div></section>' +
      '<section class="lap-charts" aria-label="Grafik laporan"><div class="card chart-card"><div class="row-between"><h3 id="judul-tren">Tren Kehadiran</h3><div class="legend">' +
      '<span><i class="dot" style="background:var(--green)"></i>Hadir (termasuk terlambat)</span><span><i class="dot" style="background:var(--orange)"></i>Terlambat</span></div></div>' +
      '<div class="chart-box" id="chart-tren" role="img" aria-labelledby="judul-tren">' + (tren.label.length ? '' : '<p class="muted small chart-empty">Belum ada data untuk grafik pada filter ini.</p>') + '</div></div>' +
      '<div class="card chart-card"><h3>Distribusi Status</h3>' + dist + '</div></section>' +
      '<section class="card table-card" aria-labelledby="judul-daftar"><div class="row-between daftar-head lap-head"><div><h3 id="judul-daftar">Detail Laporan Absensi</h3><span class="muted small">Periode ' +
      esc(Core.formatRentang(f.dari, f.sampai)) + ' · ' + (total ? total + ' data ditemukan (menampilkan ' + awal + '–' + akhir + ')' : '0 data ditemukan') + '</span></div>' +
      '<div class="lap-tools"><input type="search" id="f-q" name="q" form="form-filter" value="' + esc(f.q) + '" class="search lap-search" placeholder="Cari nama atau ID..." autocomplete="off" maxlength="100" aria-label="Cari nama atau ID karyawan">' +
      '<a class="btn btn-outline" id="btn-xlsx" href="#">Ekspor Excel</a><a class="btn btn-outline" id="btn-csv" href="#">Unduh CSV</a>' +
      '<a class="btn btn-outline" id="btn-cetak" href="' + href('laporan/cetak', args) + '" target="_blank" rel="noopener">Cetak Laporan</a></div></div>' +
      '<div class="table-scroll scroll-laporan"><table class="table table-laporan"><thead><tr><th>No.</th><th>Tanggal</th><th>ID Karyawan</th><th>Nama Karyawan</th><th>Jabatan</th><th>Jam Datang</th><th>Jam Pulang</th><th>Status Absensi</th><th>Keterangan</th></tr></thead><tbody>' +
      trs + '</tbody></table></div><div class="row-between"><span class="muted small">Jam dalam WIB</span>' + paginationHTML(page, jumlahHal, Core.daftarHalaman(page, jumlahHal), link) + '</div></section>';

    return {
      title: 'Laporan Absensi - Sistem Absensi', active: 'laporan', main: 'content-fit content-fit-auto content-laporan', html: html,
      after: function () {
        var form = $('#form-filter'), periode = $('#f-periode'), dari = $('#f-dari'), sampai = $('#f-sampai'), q = $('#f-q'), timer;
        periode.addEventListener('change', function () {
          var cst = periode.value === 'rentang';
          dari.disabled = sampai.disabled = !cst;
          if (!cst) { var r = Core.rentangPeriode(periode.value, k.hariIni); dari.value = r[0]; sampai.value = r[1]; dari.max = ''; sampai.min = ''; }
        });
        dari.addEventListener('change', function () { if (dari.value) sampai.min = dari.value; });
        sampai.addEventListener('change', function () { if (sampai.value) dari.max = sampai.value; });
        form.addEventListener('submit', function (e) { e.preventDefault(); navigate(href('laporan', formObj(form))); });
        q.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () { refocus = 'f-q'; navigate(href('laporan', formObj(form))); }, 400);
        });
        $('#btn-csv').addEventListener('click', function (e) {
          e.preventDefault();
          if (errors.length) { errors.forEach(function (m) { flash('error', m); }); render(); return; }
          download('laporan_absensi_' + f.dari + '_' + f.sampai + '.csv', [Core.csvLaporan(f, rows, stats, Core.formatTanggalWaktu(Core.sekarang()))], 'text/csv;charset=utf-8');
        });
        $('#btn-xlsx').addEventListener('click', function (e) {
          e.preventDefault();
          if (errors.length) { errors.forEach(function (m) { flash('error', m); }); render(); return; }
          eksporExcel(f, rows, stats);
        });
        gambarTren(tren);
      }
    };
  }

  // ---- grafik tren (SVG, tanpa library) ----
  function gambarTren(T) {
    if (chartObserver) { chartObserver.disconnect(); chartObserver = null; }
    var box = $('#chart-tren');
    if (!box || !T.label.length) return;
    var NS = 'http://www.w3.org/2000/svg';
    function el(tag, attrs, parent) {
      var e = document.createElementNS(NS, tag);
      for (var k in attrs) e.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(e);
      return e;
    }
    function gambar() {
      $$('svg', box).forEach(function (s) { s.remove(); });
      var W = Math.max(box.clientWidth, 280), H = Math.max(box.clientHeight, 120);
      var m = { t: 10, r: 10, b: 24, l: 30 };
      var pw = W - m.l - m.r, ph = H - m.t - m.b, n = T.label.length;
      var maks = Math.max(1, Math.max.apply(null, T.hadir));
      var langkah = Math.max(1, Math.ceil(maks / 4)), ymaks = Math.ceil(maks / langkah) * langkah;
      var svg = el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
      function x(i) { return m.l + (n === 1 ? pw / 2 : pw * i / (n - 1)); }
      function y(v) { return m.t + ph - ph * v / ymaks; }
      for (var v = 0; v <= ymaks; v += langkah) {
        el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--border)', 'stroke-width': 1 }, svg);
        el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, svg).textContent = v;
      }
      var tiap = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 56))));
      for (var i = 0; i < n; i += tiap) {
        el('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, svg).textContent = T.label[i];
      }
      [['hadir', 'var(--green)', 'Hadir'], ['terlambat', 'var(--orange)', 'Terlambat']].forEach(function (s) {
        var pts = T[s[0]].map(function (v, i) { return x(i) + ',' + y(v); }).join(' ');
        if (n > 1) el('polyline', { points: pts, fill: 'none', stroke: s[1], 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
        T[s[0]].forEach(function (v, i) {
          var c = el('circle', { cx: x(i), cy: y(v), r: n > 60 ? 2 : 3.5, fill: s[1] }, svg);
          el('title', {}, c).textContent = T.penuh[i] + ' — ' + s[2] + ': ' + v + ' karyawan';
        });
      });
      box.appendChild(svg);
    }
    gambar();
    if (window.ResizeObserver) { chartObserver = new ResizeObserver(gambar); chartObserver.observe(box); }
    else window.addEventListener('resize', gambar);
  }

  // ---- ekspor Excel (ExcelJS dimuat dari CDN hanya saat dibutuhkan) ----
  var excelPromise = null;
  function muatExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!excelPromise) excelPromise = new Promise(function (ok, gagal) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      s.onload = function () { ok(window.ExcelJS); };
      s.onerror = function () { excelPromise = null; gagal(new Error('gagal memuat')); };
      document.head.appendChild(s);
    });
    return excelPromise;
  }
  function eksporExcel(f, rows, stats) {
    var tombol = $('#btn-xlsx'); tombol.textContent = 'Menyiapkan…';
    muatExcelJS().then(function (ExcelJS) {
      var wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Laporan Absensi');
      ws.getCell('A1').value = 'Laporan Absensi'; ws.getCell('A1').font = { bold: true, size: 14 };
      var baris = 2, waktu = Core.formatTanggalWaktu(Core.sekarang());
      Core.ringkasanFilter(f).concat([['Diekspor pada', waktu]]).forEach(function (r) {
        ws.getCell(baris, 1).value = r[0]; ws.getCell(baris, 1).font = { bold: true };
        ws.getCell(baris, 2).value = String(r[1]); baris++;
      });
      [['Total Karyawan', stats.karyawan], ['Total Hadir (karyawan x hari)', stats.hadir], ['Total Terlambat', stats.terlambat],
        ['Total Tidak Hadir', stats.tidak_hadir], ['Izin', stats.izin], ['Cuti', stats.cuti]].forEach(function (r) {
        ws.getCell(baris, 1).value = r[0]; ws.getCell(baris, 1).font = { bold: true };
        ws.getCell(baris, 2).value = r[1]; ws.getCell(baris, 2).alignment = { horizontal: 'left' }; baris++;
      });
      baris++;
      var header = baris, garis = { style: 'thin', color: { argb: 'FFD1D5DB' } }, border = { top: garis, bottom: garis, left: garis, right: garis };
      Core.KOLOM_LAPORAN.forEach(function (nama, i) {
        var c = ws.getCell(header, i + 1); c.value = nama;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
        c.alignment = { horizontal: 'center', vertical: 'middle' }; c.border = border;
      });
      rows.forEach(function (r, i) {
        var n = header + i + 1;
        ws.getCell(n, 1).value = i + 1;
        var d = ws.getCell(n, 2); d.value = new Date(Core.toUTC(r.tanggal)); d.numFmt = 'yyyy-mm-dd'; d.alignment = { horizontal: 'left' };
        [r.id, r.nama, r.jabatan, Core.jamAtauStrip(r.datang), Core.jamAtauStrip(r.pulang), r.label, r.keterangan].forEach(function (v, j) {
          ws.getCell(n, 3 + j).value = String(v == null ? '' : v);
        });
        for (var c = 1; c <= 9; c++) ws.getCell(n, c).border = border;
      });
      [30, 13, 13, 24, 22, 12, 12, 16, 40].forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
      ws.autoFilter = { from: { row: header, column: 1 }, to: { row: header + Math.max(rows.length, 1), column: 9 } };
      ws.pageSetup = { orientation: 'landscape', printTitlesRow: header + ':' + header };
      return wb.xlsx.writeBuffer();
    }).then(function (buf) {
      download('laporan_absensi_' + f.dari + '_' + f.sampai + '.xlsx', [buf], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }).catch(function () {
      flash('error', 'Ekspor Excel membutuhkan koneksi internet untuk memuat library ExcelJS. Coba lagi atau gunakan Unduh CSV.');
      render();
    }).then(function () { var t = $('#btn-xlsx'); if (t) t.textContent = 'Ekspor Excel'; });
  }

  // ---- halaman cetak laporan ----
  var CETAK_CSS = 'body { background: #fff; padding: 24px; }' +
    '.cetak-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 18px; }' +
    '.cetak h1 { font-size: 20px; margin-bottom: 2px; }' +
    '.cetak-meta { margin: 10px 0 14px; display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; font-size: 13px; }' +
    '.cetak-meta dt { color: var(--muted); }' +
    '.cetak-ringkas { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 16px; }' +
    '.cetak-ringkas div { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; }' +
    '.cetak-ringkas strong { font-size: 18px; }' +
    '.cetak table { margin: 0; font-size: 12px; }' +
    '.cetak th, .cetak td { padding: 6px 6px; }' +
    '.cetak thead { display: table-header-group; }' +
    '.cetak tr { break-inside: avoid; }' +
    '@page { size: A4 landscape; margin: 12mm; }' +
    '@media print { body { padding: 0; } .cetak-bar { display: none; } .badge { border: 1px solid #d1d5db; } }';

  function vCetak(query) {
    var k = Core.konteksLaporan(argsOf(query));
    if (k.errors.length) { k.errors.forEach(function (m) { flash('error', m); }); navigate(href('laporan', Object.assign({}, Core.argsLaporan(k.f))), true); return null; }
    var f = k.f, rows = k.rows, stats = k.stats;
    var trs = rows.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td class="nowrap">' + esc(Core.formatTanggalPendek(r.tanggal)) + '</td><td>' + esc(r.id) + '</td><td>' + esc(r.nama) + '</td><td>' + esc(r.jabatan) +
        '</td><td>' + Core.jamAtauStrip(r.datang) + '</td><td>' + Core.jamAtauStrip(r.pulang) + '</td><td><span class="badge ' + badgeLaporan(r.label) + '">' + esc(r.label) + '</span></td><td>' + esc(r.keterangan || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="center muted">Tidak ada data pada periode dan filter ini.</td></tr>';
    var html = '<div class="cetak-bar"><button type="button" class="btn btn-primary" id="btn-print">Cetak / Simpan sebagai PDF</button>' +
      '<a class="btn btn-outline" href="' + href('laporan', Core.argsLaporan(f)) + '">Kembali ke Laporan</a>' +
      '<span class="muted small">Di dialog cetak, pilih “Simpan sebagai PDF” untuk menghasilkan file PDF.</span></div>' +
      '<div class="cetak"><h1>Laporan Absensi</h1><p class="muted">Rekap dan analisis kehadiran karyawan</p><dl class="cetak-meta">' +
      Core.ringkasanFilter(f).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') +
      '<dt>Dicetak pada</dt><dd>' + esc(Core.formatTanggalWaktu(Core.sekarang())) + '</dd></dl><div class="cetak-ringkas">' +
      [['Total Karyawan', stats.karyawan], ['Total Hadir', stats.hadir], ['Total Terlambat', stats.terlambat], ['Total Tidak Hadir', stats.tidak_hadir], ['Izin', stats.izin], ['Cuti', stats.cuti]]
        .map(function (r) { return '<div><span class="muted small">' + r[0] + '</span><strong>' + r[1] + '</strong></div>'; }).join('') + '</div>' +
      '<p class="muted small" style="margin-bottom:8px">Angka dihitung per karyawan per hari. Total Hadir termasuk yang terlambat. ' + rows.length + ' data.</p>' +
      '<table class="table"><thead><tr><th>No.</th><th>Tanggal</th><th>ID Karyawan</th><th>Nama Karyawan</th><th>Jabatan</th><th>Jam Datang</th><th>Jam Pulang</th><th>Status Absensi</th><th>Keterangan</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
    return {
      title: 'Laporan Absensi ' + f.dari + ' – ' + f.sampai, bare: true, cetak: true, html: html,
      after: function () {
        $('#btn-print').addEventListener('click', function () { window.print(); });
        setTimeout(function () { if (parseHash().path === 'laporan/cetak') window.print(); }, 300);
      }
    };
  }

  // =====================================================================
  // ROUTER
  // =====================================================================
  function render(modal) {
    var r = parseHash(), name = r.path, user = getUser();
    if (name === 'logout') { setUser(null); flashes = []; navigate('#/login', true); return; }
    if (!name) name = user ? 'dashboard' : 'login';
    if (name !== 'login' && !user) { navigate('#/login', true); return; }
    var view;
    if (name === 'login') view = vLogin();
    else if (name === 'dashboard') view = vDashboard();
    else if (name === 'karyawan') view = vKaryawan(r.query, modal);
    else if (name === 'absensi') view = vAbsensi();
    else if (name === 'riwayat') view = vRiwayat(r.query);
    else if (name === 'pengajuan') view = vPengajuan(r.query, modal);
    else if (name === 'laporan') view = vLaporan(r.query);
    else if (name === 'laporan/cetak') view = vCetak(r.query);
    else { navigate('#/dashboard', true); return; }
    if (!view) return;

    var estilo = $('#cetak-style'); if (estilo) estilo.remove();
    if (view.cetak) { var st = document.createElement('style'); st.id = 'cetak-style'; st.textContent = CETAK_CSS; document.head.appendChild(st); }
    document.title = view.title;
    APP.innerHTML = view.bare ? view.html : layout(view.active, view.main, view.html);
    window.scrollTo(0, 0);
    if (view.after) view.after();
    if (refocus) {
      var inp = document.getElementById(refocus); refocus = null;
      if (inp) { inp.focus(); var n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (e) {} }
    }
  }

  window.addEventListener('hashchange', function () { render(); });
  // data diubah dari tab lain: muat ulang dan gambar ulang (kecuali sedang ada dialog terbuka)
  window.addEventListener('storage', function (e) {
    if (e.key === 'absensi_db_v1') { Core.load(); if (!$('dialog[open]')) render(); }
    if (e.key === USER_KEY && !getUser() && parseHash().path !== 'login') render();
  });

  Core.load();
  render();
})();
