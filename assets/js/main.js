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

// A release's player: its tracklist, playing its own files (on media.fractalfantasy.net); click a song to
// play it (again to pause), and it moves on to the next one. Before the release date, only the songs
// in `singles` (track index -> its release date) play, each from its date on, by the visitor's own
// calendar; the rest are greyed out until the release date.
function trackPlayer(container, release) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const canPlay = (i) => !release.singles || today >= release.date || (release.singles[i] ?? "9999") <= today;
  container.innerHTML = `
    <ol class="tracklist">
      ${release.tracks.map((t, i) => `
        <li><button class="track" data-i="${i}"${canPlay(i) ? "" : " disabled"}>
          <span class="t-num">${i + 1}</span><span class="t-title">${t}</span><span class="t-len">${release.lengths?.[i] ?? ""}</span>
        </button></li>`).join("")}
    </ol>
  `;
  const audio = new Audio();
  audio.preload = "none";
  const rows = [...container.querySelectorAll(".track")];
  let current = -1;
  const show = () => rows.forEach((r, i) => {
    r.classList.toggle("current", i === current);
    r.classList.toggle("playing", i === current && !audio.paused);
  });
  const play = (i) => {
    if (i !== current) { current = i; audio.src = release.audio[i]; }
    audio.play().catch(() => {});
  };
  rows.forEach((r, i) => r.addEventListener("click", () => (i === current && !audio.paused ? audio.pause() : play(i))));
  audio.addEventListener("play", show);
  audio.addEventListener("pause", show);
  audio.addEventListener("ended", () => {
    const next = release.audio.findIndex((_, i) => i > current && canPlay(i));
    if (next >= 0) play(next); else { current = -1; show(); }
  });
  container.stop = () => { audio.pause(); audio.removeAttribute("src"); };
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

  const platforms = [
    { key: "spotify", label: "Spotify" },
    { key: "appleMusic", label: "Apple Music" },
    { key: "youtube", label: "YouTube" },
    { key: "bandcamp", label: "Bandcamp" },
  ];

  overlay.querySelector(".modal-platforms").innerHTML = platforms
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
  if (player) {
    player.stop?.(); // a detached <audio> would keep playing
    player.stop = null;
    player.innerHTML = ""; // stop playback
  }
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
