// JASHIM's album and a small player shared by the press kit's formats (jashim/formats/1-5). One <audio>;
// each page styles its own controls, marked with data attributes:
//   data-play="3"   plays song 3 (or pauses it if it's the one playing)
//   data-toggle     play / pause (the current song, or the first)
//   data-next, data-prev
//   data-now        the current song's title       data-time  0:42 / 2:40
//   data-seek       a bar: click or drag to seek; its child [data-progress] is sized to the position (width %)
// The page gets classes: body.is-playing; [data-play] of the current song .is-current (.is-playing too while playing).
(function () {
  var MEDIA = 'https://media.fractalfantasy.net/jashim/';
  var V = { '03-llueven-balas-en-el-club': '?v=2' }; // a replaced master: fetched fresh
  var files = ['01-yo-se', '02-explosion-del-corazon', '03-llueven-balas-en-el-club', '04-gistro', '05-volver-por-mi',
    '06-la-sigo', '07-para-maria', '08-loup-garou', '09-con-migo', '10-exztasi', '11-luna-dime'];
  var titles = ['Yo Sé', 'Explosión del Corazón', 'Llueven Balas en el Club', 'Gistro', 'Volver por Mí',
    'La Sigo', 'Para Maria', 'Loup-Garou', 'Con Migo', 'Exztasi', 'Luna Dime'];
  var features = ['', 'vskz', '', 'Moonstar', '', '', 'Sinjin Hawke', '', 'Xlow', 'KIDDEIN', ''];
  var lengths = ['2:40', '3:26', '3:17', '2:40', '2:11', '3:03', '4:14', '3:13', '2:44', '4:02', '3:22'];
  var SONGS = files.map(function (f, i) {
    return { n: i + 1, file: MEDIA + f + '.mp3' + (V[f] || ''), title: titles[i], feat: features[i], length: lengths[i],
      full: titles[i] + (features[i] ? ' (feat. ' + features[i] + ')' : '') };
  });
  var ALBUM = {
    artist: 'JASHIM', title: 'JASHIM', label: 'Visceral Vaults', cat: 'VV007', release: 'Friday, November 6th 2026', releaseShort: '06.11.2026',
    producer: 'Sinjin Hawke', guests: 'vskz, Moonstar, Xlow, KIDDEIN, Sinjin Hawke', presave: 'https://VisceralVaults.lnk.to/JASHIM',
    singles: [
      { title: 'Yo Sé', out: 'October 2nd', link: 'https://visceralvaults.lnk.to/YoSe', art: '../img/single-yo-se.jpg', song: 0,
        text: 'JASHIM’s first single introduces the world of his self-titled debut: a hazy, sensual Latin club track built around beautiful micromelodies, a rolling dembow rhythm, and the intimate chemistry of a summer night. Smooth rhodes chords float above a deep UK bassline, creating a contrast between warmth and low-end pressure. Lyrically, the song captures the charged feeling of two people caught up in the same late-night frequency: flirting, desire, intoxication.' },
      { title: 'Gistro (feat. Moonstar)', out: 'October 16th', link: 'https://VisceralVaults.lnk.to/Gistro', art: '../img/single-2.jpg', song: 3,
        text: '“GISTRO” is the second single from JASHIM’s self-titled LP, pushing the project deeper into JASHIM’s club universe with a high-energy Neoperreo track produced by Sinjin Hawke. A sidechained electro bassline drives the track with a powerful, elastic pulse, colliding with crunk energy and hard-hitting club percussion. Legendary Montreal Vogue commentator Moonstar delivers cunty ballroom vocals that turn the track into a call-to-action for baddies.' },
    ],
    bio: [
      'JASHIM releases his self-titled debut album ‘JASHIM’, an exploration of courtship and love in Montreal’s latinx underground.',
      'The record moves between euphoria and vulnerability: beautiful micromelodies, guaracha, and the tension of two people caught on the same late-night frequency. It feels like a melancholic perreo on a mid-summer night.',
      'Jashim’s Colombian roots collide with the global zeitgeist as he moves through Guaracha, Neo-Perreo, Reggaeton, Brega Funk, Electro and Ballroom/Vogue. The album brings together artists from Colombia, Mexico and Quebec, switching fluidly between Spanish and French to build a cross-cultural dialogue that pushes the boundaries of Latin club music.',
      'Guests include vskz, Moonstar, Xlow, KIDDEIN and Sinjin Hawke, who also executive-produced the record. From the rolling dembow and deep UK bass of lead single ‘Yo Sé’ onward, the album dances between the romantic and the hedonistic: songs for perreo, with a melodic and emotional softness underneath.',
    ],
    out: '‘JASHIM’ will be available on Friday, November 6th 2026 via all significant digital retailers on Visceral Vaults, a sublabel of Fractal Fantasy.',
    photos: ['../img/press-4.jpg', '../img/press-1.jpg', '../img/press-goggles.jpg', '../img/press-2.jpg', '../img/press-3.jpg'],
    cover: '../img/jashim-cover.jpg', contact: 'info@visceralvaults.com',
  };

  var audio = new Audio(), current = -1;
  audio.preload = 'none';
  var fmt = function (s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  function draw() {
    var playing = !audio.paused && current >= 0;
    document.body.classList.toggle('is-playing', playing);
    all('[data-play]').forEach(function (e) {
      var me = Number(e.dataset.play) === current;
      e.classList.toggle('is-current', me);
      e.classList.toggle('is-playing', me && playing);
    });
    all('[data-now]').forEach(function (e) { e.textContent = current >= 0 ? SONGS[current].full : 'JASHIM'; });
    all('[data-toggle]').forEach(function (e) { e.setAttribute('aria-label', playing ? 'Pause' : 'Play'); });
    tick();
  }
  function tick() {
    var d = audio.duration || 0, t = audio.currentTime || 0;
    all('[data-time]').forEach(function (e) { e.textContent = current >= 0 ? fmt(t) + ' / ' + (d ? fmt(d) : SONGS[current].length) : ''; });
    all('[data-seek]').forEach(function (bar) {
      var own = bar.dataset.seek, p = bar.querySelector('[data-progress]');
      if (!p) return;
      var mine = own === '' || own === undefined || Number(own) === current;
      p.style.width = (mine && d ? (100 * t / d) : 0) + '%';
    });
  }
  function play(i) {
    if (i === current) { if (audio.paused) audio.play(); else audio.pause(); return; }
    current = (i + SONGS.length) % SONGS.length;
    audio.src = SONGS[current].file;
    audio.play();
    draw();
  }
  audio.addEventListener('play', draw);
  audio.addEventListener('pause', draw);
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('loadedmetadata', tick);
  audio.addEventListener('ended', function () { play(current + 1); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-play],[data-toggle],[data-next],[data-prev]');
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute('data-play')) play(Number(t.dataset.play));
    else if (t.hasAttribute('data-toggle')) play(current < 0 ? 0 : current);
    else if (t.hasAttribute('data-next')) play(current + 1);
    else play(current <= 0 ? SONGS.length - 1 : current - 1);
  });
  // seeking: press on a bar and drag
  document.addEventListener('pointerdown', function (e) {
    var bar = e.target.closest('[data-seek]');
    if (!bar) return;
    var own = bar.dataset.seek;
    if (own !== '' && own !== undefined && Number(own) !== current) { play(Number(own)); return; }
    if (current < 0) return;
    var to = function (ev) { var r = bar.getBoundingClientRect(); if (audio.duration) audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * audio.duration; tick(); };
    to(e);
    var move = function (ev) { to(ev); }, up = function () { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); play(current < 0 ? 0 : current); }
  });
  window.JASHIM = { SONGS: SONGS, ALBUM: ALBUM, play: play, audio: audio, draw: draw };
  document.addEventListener('DOMContentLoaded', draw);
})();
