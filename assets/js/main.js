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
      <p class="r-date">${new Date(r.date).getFullYear()}</p>
    </button>
  `;
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
    .join("");

  const playerHeight = 120 + release.tracks.length * 48;
  const player = overlay.querySelector(".modal-player");
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
  if (player) player.innerHTML = ""; // stop playback
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
