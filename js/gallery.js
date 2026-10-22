// gallery.js
// Full-screen photo viewer for the flight card: swipe or use the arrows / arrow keys; Esc closes.
// Each photo keeps its credit and links to its own page, as the sources require:
//   Planespotters.net: "© photographer" and the photo links to its page (their terms).
//   Wikimedia Commons: author, licence (linked) and a link to the file page (the licences require it).
// All text from the internet goes in with textContent.

let root = null;
let photos = [];
let index = 0;
let lastFocus = null;

function h(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function link(url, text) {
  const a = h('a', null, text);
  if (/^https:\/\//.test(url ?? '')) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
}

function build() {
  root = h('div', 'gallery');
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Aircraft photos');
  root.innerHTML = '<button type="button" class="gallery__close" aria-label="Close photos">✕</button>' +
    '<div class="gallery__count"></div>' +
    '<button type="button" class="gallery__nav gallery__nav--prev" aria-label="Previous photo">‹</button>' +
    '<figure class="gallery__fig"><a class="gallery__imglink" target="_blank" rel="noopener noreferrer"><img alt=""></a><figcaption class="gallery__cap"></figcaption></figure>' +
    '<button type="button" class="gallery__nav gallery__nav--next" aria-label="Next photo">›</button>' +
    '<div class="gallery__thumbs"></div>'; // fixed markup only; photos are filled in below with DOM methods
  document.body.append(root);
  root.querySelector('.gallery__close').addEventListener('click', closeGallery);
  root.querySelector('.gallery__nav--prev').addEventListener('click', () => show(index - 1));
  root.querySelector('.gallery__nav--next').addEventListener('click', () => show(index + 1));
  root.addEventListener('click', (e) => { if (e.target === root) closeGallery(); }); // click the dark background
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') closeGallery();
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
  // Swipe left/right on phones.
  let startX = null;
  const fig = root.querySelector('.gallery__fig');
  fig.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  fig.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
  });
}

function show(i) {
  index = (i + photos.length) % photos.length;
  const p = photos[index];
  const img = root.querySelector('.gallery__fig img');
  img.src = p.src;
  img.alt = p.title ? `Photo: ${p.title}` : 'Aircraft photo';
  const imgLink = root.querySelector('.gallery__imglink');
  if (/^https:\/\//.test(p.pageUrl ?? '')) imgLink.href = p.pageUrl; else imgLink.removeAttribute('href');
  const cap = root.querySelector('.gallery__cap');
  cap.replaceChildren(`© ${p.photographer ?? 'Unknown photographer'}`);
  if (p.source === 'commons') {
    cap.append(' · ', p.licenseUrl ? link(p.licenseUrl, p.license) : p.license, ' · ', link(p.pageUrl, 'Wikimedia Commons'));
    cap.append(h('span', 'gallery__date', p.taken ? `Taken ${takenText(p.taken)}` : 'Date taken unknown'));
    cap.append(h('small', null, 'Matched by registration. Registrations are sometimes reused, so an older photo may show another aircraft.'));
  } else {
    cap.append(' · ', link(p.pageUrl, 'via Planespotters.net'));
    cap.append(h('span', 'gallery__date', 'Date not given by Planespotters'));
  }
  root.querySelector('.gallery__count').textContent = `${index + 1} / ${photos.length}`;
  const many = photos.length > 1;
  root.querySelectorAll('.gallery__nav').forEach((b) => { b.hidden = !many; });
  root.querySelectorAll('.gallery__thumbs button').forEach((b, k) => b.setAttribute('aria-current', String(k === index)));
}

// "26 Oct 2025", "Oct 2025" or "2025": never more precise than the source.
export function takenText(taken) {
  const opts = { timeZone: 'UTC', year: 'numeric' };
  if (taken.precision !== 'year') opts.month = 'short';
  if (taken.precision === 'day') opts.day = 'numeric';
  return new Date(taken.ms).toLocaleDateString('en-GB', opts);
}

// photos: [{ src, pageUrl, photographer, source: 'planespotters' | 'commons', license?, licenseUrl?, title? }]
export function openGallery(list, start = 0) {
  if (!list.length) return;
  if (!root) build();
  photos = list;
  lastFocus = document.activeElement;
  const strip = root.querySelector('.gallery__thumbs');
  strip.replaceChildren(...list.map((p, k) => {
    const b = h('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Photo ${k + 1}`);
    const img = h('img');
    img.src = p.src;
    img.alt = '';
    img.loading = 'lazy';
    b.append(img);
    b.addEventListener('click', () => show(k));
    return b;
  }));
  strip.hidden = list.length < 2;
  root.hidden = false;
  document.body.classList.add('gallery-open');
  show(start);
  root.querySelector('.gallery__close').focus();
}

export function closeGallery() {
  if (!root || root.hidden) return;
  root.hidden = true;
  document.body.classList.remove('gallery-open');
  lastFocus?.focus?.();
}
