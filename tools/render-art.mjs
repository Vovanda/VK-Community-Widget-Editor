/* Картинки приложения для настроек VK (vk.ru/editapp?id=7100465): PNG иконки и
   обложек из SVG в assets/vk-app и скриншоты интерфейса для экрана установки.

   VK принимает растровые файлы строго заданных размеров, поэтому исходник — SVG,
   а PNG рендерятся отсюда. Скриншоты снимаются с живой страницы, как в смоке:

       python -m http.server 8743 &
       node tools/render-art.mjs

   SMOKE_CHROME — путь к уже установленному Chromium, SMOKE_URL — адрес страницы. */

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const URL = process.env.SMOKE_URL || "http://localhost:8743/index.htm";
const ART = new globalThis.URL("../assets/vk-app/", import.meta.url);
// Размеры со страницы настроек приложения.
const RASTERS = [
  { svg: "icon.svg", png: "icon-32.png", size: 32 },
  { svg: "cover.svg", png: "cover-150.png", size: 150 },
  { svg: "cover.svg", png: "cover-278.png", size: 278 },
];
// Колонка VK на компьютере ~650px; двойная плотность — чтобы скриншот не мылился.
const SCREEN = { width: 650, height: 900 };

const browser = await chromium.launch(process.env.SMOKE_CHROME ? { executablePath: process.env.SMOKE_CHROME } : {});

for (const { svg, png, size } of RASTERS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const data = readFileSync(new globalThis.URL(svg, ART)).toString("base64");
  await page.setContent(`<style>html,body{margin:0}img{display:block}</style>
    <img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}">`);
  await page.locator("img").screenshot({ path: fileURLToPath(new globalThis.URL(png, ART)) });
  await page.close();
}

// Скрипты VK подменяются, как в смоке: статус «Подключено», кнопки VK включены.
const context = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
await page.route(/cdnjs\.cloudflare\.com/, route => route.abort());
await page.route(/vk\.com\/js\/api\//, route => route.fulfill({
  contentType: "text/javascript",
  body: "window.VK = { init(ok) { ok(); }, callMethod() {}, addCallback() {} };",
}));
await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector(".CodeMirror", { state: "attached" });
const veoomsk = readFileSync(new globalThis.URL("../templates/veoomsk/RandomTextInWidget.vks", import.meta.url), "utf8");
await page.evaluate(code => document.querySelector(".CodeMirror").CodeMirror.setValue(code), veoomsk);

// Кадр — карточка редактора от заголовка до предупреждения о хранении: подвал со
// ссылками на экране установки только отвлекает.
const shoot = async name => {
  const clip = await page.evaluate(() => {
    const app = document.querySelector(".app").getBoundingClientRect();
    const note = document.getElementById("storageNote").getBoundingClientRect();
    return { x: app.x, y: app.y, width: app.width, height: note.bottom + 12 - app.y };
  });
  await page.screenshot({ path: fileURLToPath(new globalThis.URL(name, ART)), clip });
};

// Форма: всё свёрнуто, открыт один самый короткий блок — видны и все списки,
// найденные в скрипте, и элементы одного из них, без простыни полей.
await page.click("#formTab");
await page.click(".form-collapse-all");
await page.evaluate(() => {
  const blocks = [...document.querySelectorAll("details.form-block")];
  const cards = block => block.querySelectorAll("details:not(.form-block)").length;
  const shortest = blocks.filter(block => cards(block) >= 3).sort((a, b) => cards(a) - cards(b))[0];
  if (shortest) shortest.open = true;
});
await shoot("screen-form.png");

await page.click("#codeTab");
await shoot("screen-code.png");
await context.close();

// Баннер «Выбора редакции» вставляет screen-form.png относительной ссылкой, поэтому
// открывается файлом, а не через data:, и рендерится после скриншотов.
const banner = await browser.newPage({ viewport: { width: 1120, height: 630 } });
await banner.goto(new globalThis.URL("banner.svg", ART).href);
await banner.screenshot({ path: fileURLToPath(new globalThis.URL("banner-1120.png", ART)) });

await browser.close();
console.log("готово: assets/vk-app");
