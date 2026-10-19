import { CONFIG } from './config';
import { isServingHost } from './host';
import { describeJoinLink } from './join-link';

const webOpen =
  CONFIG.webJoinEnabled && CONFIG.turnstileSiteKey !== '' && isServingHost(location.hostname);
const view = describeJoinLink(location.search, webOpen);

document.querySelectorAll<HTMLAnchorElement>('[data-app-store]').forEach((a) => (a.href = CONFIG.appStoreUrl));
document.querySelectorAll<HTMLAnchorElement>('[data-play-store]').forEach((a) => (a.href = CONFIG.playStoreUrl));

const show = (id: string) => ((document.getElementById(id) as HTMLElement).hidden = false);

if (view.kind === 'bad') {
  show('screen-bad');
} else if (view.kind === 'transfer') {
  (document.getElementById('open-transfer') as HTMLAnchorElement).href = view.appHref;
  show('screen-transfer');
} else {
  const cells = document.getElementById('code') as HTMLElement;
  for (const char of view.code) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.textContent = char;
    cells.appendChild(cell);
  }
  (document.getElementById('open') as HTMLAnchorElement).href = view.appHref;
  const web = document.getElementById('web') as HTMLAnchorElement;
  if (view.webHref) {
    web.href = view.webHref;
    web.hidden = false;
  }
  document.title = `房間碼 ${view.code} — SharedRoll`;
  show('screen-room');
}
