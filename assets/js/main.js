// Visceral Vaults — shared site behavior

function initNavToggle() {
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".main-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => nav.classList.toggle("open"));
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

async function loadReleases() {
  const res = await fetch("data/releases.json");
  const releases = await res.json();
  return releases.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function releaseCardHTML(r) {
  return `
    <button class="release-card" data-id="${r.id}">
      <img src="${r.cover}" alt="${r.title} cover art" loading="lazy">
      <p class="r-title">${r.title}</p>
      <p class="r-artist">${r.artist}</p>
    </button>
  `;
}

// Before a release's date, only the songs in `singles` (track index -> its release date) play, each from
// its date on, by the visitor's own calendar; the rest are greyed out until the release date.
function canPlay(release, i) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return !release.singles || today >= release.date || (release.singles[i] ?? "9999") <= today;
}

// The player bar at the bottom of the page (fractalfantasy.net's FFPlayer), holding one release's
// playable songs at a time: a song clicked in another release's pop-up rebuilds it for that release.
let bar = null; // { player, release, indexes: the release's track index for each of the bar's songs }

const PLATFORMS = [
  { key: "spotify", label: "Spotify" },
  { key: "appleMusic", label: "Apple Music" },
  { key: "youtube", label: "YouTube" },
  { key: "bandcamp", label: "Bandcamp" },
];

function barFor(release) {
  if (bar?.release === release) return bar;
  if (typeof FFPlayer === "undefined") return null;
  bar?.player.destroy();
  const indexes = release.tracks.map((_, i) => i).filter((i) => canPlay(release, i));
  // the link button: the release's stores, and its own links (e.g. pre-save)
  const links = PLATFORMS.filter((p) => release[p.key]).map((p) => [p.label, release[p.key]])
    .concat((release.links || []).map((l) => [l.label, l.href]));
  const player = new FFPlayer({
    title: release.title,
    artist: release.artist,
    description: "Visceral Vaults",
    mode: "audio playlist",
    src: indexes.map((i) => release.audio[i]),
    songTitle: indexes.map((i) => release.tracks[i]),
    download: links.length > 0,
    links,
    volume: true,
  });
  // a back button (the shared player has only next), as on the press page
  const back = document.createElement("button");
  back.className = "back";
  back.setAttribute("aria-label", "Previous");
  back.addEventListener("click", () => player.previousSong());
  player.container.prepend(back);
  for (const type of ["play", "pause", "emptied", "loadstart"]) player.song.addEventListener(type, showPlaying);
  bar = { player, release, indexes };
  showPlaying();
  return bar;
}

// the open pop-up's tracklist shows the bar's song (bold), and whether it's playing
function showPlaying() {
  const list = document.querySelector(".modal-player .tracklist");
  if (!list) return;
  const here = bar && bar.release.id === list.dataset.id;
  const current = here ? bar.indexes[bar.player.currentPlaylistIndex] : -1;
  list.querySelectorAll(".track").forEach((row, i) => {
    row.classList.toggle("current", i === current);
    row.classList.toggle("playing", i === current && !bar.player.song.paused);
  });
}

// A release's tracklist in its pop-up: click a song to play it in the bar (again to pause).
function trackPlayer(container, release) {
  container.innerHTML = `
    <ol class="tracklist" data-id="${release.id}">
      ${release.tracks.map((t, i) => `
        <li><button class="track" data-i="${i}"${canPlay(release, i) ? "" : " disabled"}>
          <span class="t-num">${i + 1}</span><span class="t-title">${t}</span><span class="t-len">${release.lengths?.[i] ?? ""}</span>
        </button></li>`).join("")}
    </ol>
  `;
  container.querySelectorAll(".track").forEach((row, i) => row.addEventListener("click", () => {
    const b = barFor(release);
    if (!b) return;
    const song = b.indexes.indexOf(i);
    if (song === b.player.currentPlaylistIndex && b.player.song.currentSrc === new URL(release.audio[i], location.href).href) b.player.togglePlay();
    else b.player.playSong(song);
  }));
  showPlaying();
}

function openModal(release) {
  const overlay = document.querySelector(".modal-overlay");
  if (!overlay) return;

  overlay.querySelector(".modal-cover").src = release.cover;
  overlay.querySelector(".modal-cover").alt = release.title + " cover art";
  overlay.querySelector(".modal-title").textContent = release.title;
  overlay.querySelector(".modal-artist").textContent = release.artist;

  const creditEl = overlay.querySelector(".modal-credit");
  if (release.credit) {
    creditEl.textContent = release.credit;
    creditEl.style.display = "";
  } else {
    creditEl.style.display = "none";
  }

  overlay.querySelector(".modal-date").textContent = formatDate(release.date);

  overlay.querySelector(".modal-platforms").innerHTML = PLATFORMS
    .filter((p) => release[p.key])
    .map(
      (p) => `
        <a class="platform-link" href="${release[p.key]}" target="_blank" rel="noopener" aria-label="Listen on ${p.label}" title="${p.label}">
          <img src="https://cdn.simpleicons.org/${p.key.toLowerCase()}/ffffff" alt="${p.label}" loading="lazy">
        </a>
      `
    )
    .join("") + (release.links || [])
    .map((l) => `<a class="text-link" href="${l.href}"${/^https?:/.test(l.href) ? ' target="_blank" rel="noopener"' : ""}>${l.label}</a>`)
    .join("");

  const player = overlay.querySelector(".modal-player");
  if (release.audio) {
    trackPlayer(player, release);
    overlay.classList.add("open");
    return;
  }
  const playerHeight = 120 + release.tracks.length * 48;
  player.innerHTML = `
    <iframe
      style="border: 0; width: 100%; height: ${playerHeight}px;"
      src="https://bandcamp.com/EmbeddedPlayer/album=${release.albumId}/size=large/bgcol=161616/linkcol=ffffff/tracklist=true/artwork=none/transparent=true/"
      seamless
      title="${release.title} — Bandcamp player">
    </iframe>
  `;

  overlay.classList.add("open");
}

function closeModal() {
  const overlay = document.querySelector(".modal-overlay");
  overlay?.classList.remove("open");
  const player = overlay?.querySelector(".modal-player");
  if (player) player.innerHTML = ""; // a Bandcamp embed stops; the bar plays on
}

function initReleaseGrid(releases, gridSelector) {
  const grid = document.querySelector(gridSelector);
  if (!grid) return;

  grid.innerHTML = releases.map(releaseCardHTML).join("");

  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".release-card");
    if (!card) return;
    const release = releases.find((r) => r.id === card.dataset.id);
    if (release) openModal(release);
  });
}

function initModal() {
  const overlay = document.querySelector(".modal-overlay");
  if (!overlay) return;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".modal-close")) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNavToggle();
  initModal();
});
