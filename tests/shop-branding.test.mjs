// Shop branding in the app header and customer printouts (index.html).
// Run:  node --test tests/shop-branding.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('no shop name or logo is hard-coded in the app', () => {
  assert.doesNotMatch(html, /lessard/i);
});

test('the default Casson Makes logo ships with the app', () => {
  const file = new URL('../casson-makes-logo.svg', import.meta.url);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /^<svg [^>]*viewBox="0 0 64 64"/);
});

// Run the real shopBranding() method from index.html against sample shops.
const body = html.match(/\n  shopBranding\(\) \{\n([\s\S]*?)\n  \}\n/);
// eslint-disable-next-line no-new-func
const shopBranding = (shop) => new Function(body[1]).call({ state: { shop } });

test('a shop with a logo uses its own logo, name and accent', () => {
  const b = shopBranding({ name: 'Lessard Marine Works', settings: { branding: {
    logoDataUrl: 'data:image/png;base64,AAA', accentColor: '#7E3F6E', showLogoOnPrint: true, showAccentOnPrint: true } } });
  assert.deepEqual(b, { name: 'Lessard Marine Works', logoSrc: 'data:image/png;base64,AAA', showLogoOnPrint: true, printAccent: '#7E3F6E' });
});

test('a shop without a logo gets the Casson Makes logo', () => {
  const b = shopBranding({ name: 'Casson PROD', settings: {} });
  assert.equal(b.logoSrc, './casson-makes-logo.svg');
  assert.equal(b.showLogoOnPrint, true);
  assert.equal(b.printAccent, '#16283D');
});

test('the shop can turn the logo off for printouts, and the accent off', () => {
  const b = shopBranding({ name: 'X', settings: { branding: { logoDataUrl: 'data:x', accentColor: '#123456', showLogoOnPrint: false, showAccentOnPrint: false } } });
  assert.equal(b.showLogoOnPrint, false);
  assert.equal(b.printAccent, '#16283D');
});

test('before the shop has loaded, Casson Makes is shown', () => {
  assert.deepEqual(shopBranding(null), { name: 'Casson Makes', logoSrc: './casson-makes-logo.svg', showLogoOnPrint: true, printAccent: '#16283D' });
});

// Home-screen icon (Safari "Add to Home Screen") and browser-tab icon.
const pngSize = (name) => {
  const buf = readFileSync(new URL(`../${name}`, import.meta.url));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${name} is a PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

test('home-screen icon is the Casson Makes logo at 180x180, linked from the page', () => {
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Job Tracker">/);
  assert.deepEqual(pngSize('apple-touch-icon.png'), [180, 180]);
});

test('browser-tab icon is linked and present', () => {
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/casson-makes-logo\.svg">/);
  assert.deepEqual(pngSize('favicon-32.png'), [32, 32]);
});

// Which logo the home-screen icon uses (the real homeScreenLogo() from index.html).
const homeBody = html.match(/\n  homeScreenLogo\(\) \{\n([\s\S]*?)\n  \}\n/);
// eslint-disable-next-line no-new-func
const homeScreenLogo = (state) => new Function(homeBody[1]).call({ state });
const withLogo = { name: 'Lessard Marine Works', settings: { branding: { logoDataUrl: 'data:image/png;base64,AAA' } } };

test('home-screen icon: signed in to a shop with a logo -> that logo', () => {
  assert.equal(homeScreenLogo({ session: { user: {} }, shop: withLogo }), 'data:image/png;base64,AAA');
});

test('home-screen icon: signed out, or shop has no logo -> default Casson Makes icon', () => {
  assert.equal(homeScreenLogo({ session: null, shop: withLogo }), '');
  assert.equal(homeScreenLogo({ session: { user: {} }, shop: { name: 'Casson PROD', settings: {} } }), '');
  assert.equal(homeScreenLogo({ session: { user: {} }, shop: null }), '');
});

test('the app keeps the home-screen icon in sync after every update', () => {
  assert.match(html, /\n  componentDidUpdate\(\) \{\n    this\.syncHomeScreenIcon\(\);\n  \}/);
});
