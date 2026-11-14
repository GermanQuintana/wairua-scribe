// Wairua Scribe — acceso a la beta por invitación.
// Las herramientas se desbloquean con un código personal. Aquí solo se
// guardan los hashes (SHA-256 con sal), nunca los códigos.
// Es un filtro de acceso a la beta, no una medida de seguridad: el audio
// nunca sale del navegador, así que no hay datos que proteger en un servidor.
// Para retirar un código, borra su hash y vuelve a publicar.

const SALT = 'wairua-scribe-beta-2026';
const VALID = new Set([
  'be091136b62fe1d961bb5f690b009b5fc20e2b51f9ed0dad0e6dd8d8a9f73fe0',
  '0d6a4521a0d14ce4a93e648bfca37f18d63144958f786dc8f51ec9851fb4cf9b',
  '129ce1e0df614eeacf44d21d7a1609fb492beeb09f69acb8e7785678b7d56220',
  '390c8beb669f2bdaa07af99abc3fd75210bbe78ab35198df502c4fdd2c8c21ad',
  '736fd91c68b40a9ad82587f5e9dac2d528fea3c213ccd3fce6e07212a9a0c74d',
  'd4b64951f9ec782b9716411abce15c465a8678e40e080f63c26f6d5941eebceb',
  'cbf69c1bf47b289473c93df6e5ef305718d6ea69905744ee7ab356f8c72fd208',
  'fbaec3d5bb8915b26e0e651c460d8f7044ccdadd6bec8c24721776d896d91109',
  '3fd45ca7a1b2d8a82d3c8a38f758277d31c47f23d1423734b42ac21e09057579',
  '4feb0bea119d04c9ad5df5cc7980d8d7ba7e39fae7e40820535d43394293a126',
  '0288ff9b58748acc083f335ce6eb4054984efd6eea301691dbb0caa0215c1d22',
  '545fec57d46b43c7edc57bfb163826d48bffbc3f3a081eb0eca737fef62d4f17',
  '1713865b8da250105c6e5f5834c1e8704161bdb3bab0acbf08a4e013c5026547',
  '1bd7b9f0ca4be26d979a3acfffee00ff2fa00a339b8734307be9a8e3be8a34d1',
  'ee1479992a7e8f24557878a8c2b027d7cb93a8e412e46b6813f0a671fb0605c2',
  '69027ec7952e6536ce7f37814dd753c2b65d1951d18381fdb130620b516a0723',
  'd9334433e6f8e53d65248fcf7b032ff5ed401740b84dccac5baf4eb1d1551615',
  'eb903dfb322d88ad81beaa1d95c98ed1235332d1cccdc829cd0fbe1b0383d92b',
  '72b34308de88319658f6ee815ccb5a429ea22987c3de2c86195a8683185dcc6a',
  '68294a7aae63ffa2c5bfe694ce0ef5b656f488576ec16b189cc7d36f34b41a3f',
  '0cc5a60084b40da1e2153854dd573cf0f23ae25eea84a8a571d7e4175aa579c5',
  'f0960bc5a6a641d5a6a8a326ab27378c153c17896052e47fe0b5c2b2beb0197c',
  '54d354f3f7df3c2901407395b33a3c07e0a2058d8e2f8a0e6e89fe5dd5e5c6f4',
  'db0d01488f5f679c11b83a5628c5bd6233ca5031ffdad567cc1133d4ef786b3d',
  '7c6ca1b25469a8f2162d342325ec50a74a6e1886c90f5df35c7d925b8c5d2696',
  '645f0b780967c12ad81c29da9090894708f2d72849370895ab948c0757a05e5e',
  'cc0f9698319ea100a4749c94cc26881cfc644ccb67dff9095c8b6a09cc741d0c',
  '5606fffff62de310d7c8c88375429e61608778f5b7672b7c7ae79dfdaf6c3aeb',
  '2b218ce5edc1790bd3c0dd32957d7e674817adee961e34e0eb268f7e8ee60320',
  '1cb9af4cf46d9a95b81ee30b93aac8fb052cbc6ed3e95c947bfd943bb14f2276',
  '1c31a16153f4e51f80dec93dea45608cc8c224eb13607d16c7cf87ae945c04d6',
  '84465741efbf5e456224327fd9fc381d6b8dec6904d0184aeb15d84bc4bbc20e',
  '3140337d448f1d02a762aa00d32ba57629d77d3f64636b7f24c850c3d968e0f6',
  '11a689374909154adac667020c26aea69eb2715cace52d90d87784c601139b8b',
  '36529f41cbb288c2ed57759acee451da6db91ba2e486fb585a254cc9a66fbd80',
  '8699f62bbb10ad84ff0415054d110ff3359bf33202f62407b14a6d46da6ad63e',
  'ed794608eb5f5504131713161f95cb2e15aa6c408dc0e95de6b2edfdfa278dde',
  '7f8e3481f68fb0cd949d4da7f3123358292836b352bf0e9d3b134d8cc0338f52',
  '6d7687bd2b89f90aa77fa353e02af60ca2cd5f78414ea6974cabbeeb1f5b7d60',
  '917afeef797ad1b0f3d4910c85e4aac7b892d1b0d266537edaf6751010878b02'
]);
const KEY = 'scribe-invite';
const T = (es, en) => (document.documentElement.lang === 'en' ? en : es);

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^WS/, '').replace(/^(.{4})(.{4}).*$/, 'WS-$1-$2');
const unlock = () => document.documentElement.classList.remove('locked');
const lock = () => document.documentElement.classList.add('locked');

let saved = null;
try { saved = localStorage.getItem(KEY); } catch {}
if (saved && VALID.has(saved)) unlock(); else lock();

document.querySelectorAll('.invite-form').forEach(form => form.addEventListener('submit', async e => {
  e.preventDefault();
  const input = form.querySelector('input');
  const msg = form.querySelector('.invite-msg');
  if (!window.crypto?.subtle) { msg.textContent = T('Abre la web por HTTPS para validar el código.', 'Open the site over HTTPS to validate the code.'); return; }
  const h = await sha(norm(input.value));
  if (VALID.has(h)) {
    try { localStorage.setItem(KEY, h); } catch {}
    msg.textContent = T('¡Bienvenido a la beta!', 'Welcome to the beta!'); msg.className = 'invite-msg ok';
    setTimeout(unlock, 500);
  } else {
    msg.textContent = T('Código no válido. Revisa que esté bien escrito.', 'Invalid code. Please check it.'); msg.className = 'invite-msg bad';
    form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
  }
}));
