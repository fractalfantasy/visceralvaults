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
      <img src="${r.cover}" alt="${r.title} cover art" decoding="async">
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

// The player bar at the bottom of the page (fractalfantasy.net's FFPlayer): one playlist of every
// playable song, release after release in the grid's order, so it plays on from one release into the
// next (and round again). One <audio> throughout, which phones let carry on without another tap.
// The credits and the link button follow the release playing.
let bar = null; // { player, entries: [{ release, i }] in playlist order, release: the one in the credits }

const PLATFORMS = [
  { key: "spotify", label: "Spotify" },
  { key: "appleMusic", label: "Apple Music" },
  { key: "youtube", label: "YouTube" },
  { key: "bandcamp", label: "Bandcamp" },
];

// the link button's list: the release's stores, and its own links (e.g. pre-save)
function releaseLinks(release) {
  return PLATFORMS.filter((p) => release[p.key]).map((p) => [p.label, release[p.key]])
    .concat((release.links || []).map((l) => [l.label, l.href]));
}

function initBar(releases) {
  if (typeof FFPlayer === "undefined") return;
  const entries = releases.flatMap((release) => release.tracks.map((_, i) => ({ release, i })))
    .filter(({ release, i }) => release.audio && canPlay(release, i));
  if (!entries.length) return;
  const first = entries[0].release;
  const player = new FFPlayer({
    title: first.title,
    artist: first.artist,
    description: "Visceral Vaults",
    mode: "audio playlist",
    src: entries.map(({ release, i }) => release.audio[i]),
    songTitle: entries.map(({ release, i }) => release.tracks[i]),
    download: true,
    links: releaseLinks(first),
    volume: true,
    loop: true,
  });
  // a back button (the shared player has only next), as on the press page
  const back = document.createElement("button");
  back.className = "back";
  back.setAttribute("aria-label", "Previous");
  back.addEventListener("click", () => player.previousSong());
  player.container.prepend(back);
  bar = { player, entries, release: first };
  player.addCallback("streamAudio", showRelease);
  for (const type of ["play", "pause", "emptied", "loadstart"]) player.song.addEventListener(type, showPlaying);
  showPlaying();
}

// the bar's credits and links: the release of the song it's on
function showRelease() {
  const { release } = bar.entries[bar.player.currentPlaylistIndex];
  if (bar.release === release) return;
  bar.release = release;
  bar.player.container.querySelector("#playerTitle").textContent = release.title;
  bar.player.container.querySelector("#playerArtist").textContent = release.artist;
  const panel = bar.player.container.querySelector(".ffplayer-links");
  if (panel) {
    panel.replaceChildren(...releaseLinks(release).map(([label, href]) => {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = label;
      return a;
    }));
  }
}

// the open pop-up's tracklist shows the bar's song (bold), and whether it's playing
function showPlaying() {
  const list = document.querySelector(".modal-player .tracklist");
  if (!list || !bar) return;
  const { release, i: current } = bar.entries[bar.player.currentPlaylistIndex];
  list.querySelectorAll(".track").forEach((row, i) => {
    const on = release.id === list.dataset.id && i === current;
    row.classList.toggle("current", on);
    row.classList.toggle("playing", on && !bar.player.song.paused);
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
    if (!bar) return;
    const entry = bar.entries.findIndex((e) => e.release === release && e.i === i);
    if (entry < 0) return;
    if (entry === bar.player.currentPlaylistIndex) bar.player.togglePlay();
    else bar.player.playSong(entry);
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
