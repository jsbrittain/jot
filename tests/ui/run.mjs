import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

const MOCK = `(() => {
  const now = () => new Date().toISOString();
  const seedProjects = Array.isArray(window.__MOCK_PROJECTS__) ? window.__MOCK_PROJECTS__ : [];
  const projects = seedProjects.map((name, index) => ({ id: index + 1, name: String(name) }));
  const pages = [{
    id: 1,
    content: String(window.__MOCK_PAGE__ || ""),
    createdAt: now(),
    updatedAt: now(),
    revision: 0,
    archived: false,
  }];
  const items = [];
  let nextItem = 1;
  let nextProject = projects.length + 1;
  let nextPage = 2;
  let lastProjectId = null;
  const seedItems = Number(window.__MOCK_ITEMS__ || 0);
  for (let index = 0; index < seedItems; index++) {
    const stamp = new Date(Date.now() - (seedItems - index) * 60000).toISOString();
    items.push({
      id: nextItem++,
      pageId: 1,
      content: "Seed item " + String(index + 1).padStart(2, "0"),
      projectId: projects.length ? projects[index % projects.length].id : null,
      createdAt: stamp,
      updatedAt: stamp,
      pinned: true,
      position: seedItems - index,
      doneAt: null,
      deletedAt: null,
    });
  }
  const current = () => pages.find((p) => !p.archived);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const projectName = (id) => {
    const p = projects.find((x) => x.id === id);
    return p ? p.name : null;
  };
  const outItem = (i) => ({
    id: i.id,
    pageId: i.pageId,
    content: i.content,
    projectId: i.projectId,
    projectName: projectName(i.projectId),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    pinned: i.pinned,
    position: i.position,
    doneAt: i.doneAt,
  });
  const pageOut = (p) => ({
    id: p.id,
    content: p.content,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    revision: p.revision,
    archived: p.archived,
  });
  const live = () => items.filter((i) => !i.deletedAt);
  const byPosition = (a, b) => a.position - b.position || a.id - b.id;
  const byCreated = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  const handlers = {};

  const invoke = async (cmd, args = {}) => {
    switch (cmd) {
      case "bootstrap":
        return {
          page: pageOut(current()),
          projects: clone(projects),
          board: live().filter((i) => i.pinned).sort(byPosition).map(outItem),
          lastProjectId,
        };
      case "ready":
        return undefined;
      case "save_page": {
        const page = pages.find((p) => p.id === args.pageId);
        if (!page || page.revision !== args.expectedRevision) throw new Error("stale page");
        page.content = args.content;
        page.revision += 1;
        page.updatedAt = now();
        return pageOut(page);
      }
      case "new_page": {
        const page = current();
        if (page.content.trim() === "") return pageOut(page);
        page.archived = true;
        const next = { id: nextPage++, content: "", createdAt: now(), updatedAt: now(), revision: 0, archived: false };
        pages.push(next);
        return pageOut(next);
      }
      case "list_pages":
        return clone(
          pages
            .slice()
            .sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt.localeCompare(a.updatedAt))
            .map((p) => ({
              id: p.id,
              preview: p.content.split("\\n").map((s) => s.trim()).find(Boolean) || "",
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
              archived: p.archived,
            })),
        );
      case "open_page": {
        const page = current();
        if (page.id === args.id) return pageOut(page);
        if (page.content.trim() === "") pages.splice(pages.indexOf(page), 1);
        else page.archived = true;
        const target = pages.find((p) => p.id === args.id);
        target.archived = false;
        return pageOut(target);
      }
      case "commit_snippet": {
        const page = pages.find((p) => p.id === args.pageId);
        if (!page || page.revision !== args.expectedRevision) throw new Error("stale page");
        const stamp = now();
        page.content = args.pageContent;
        page.revision += 1;
        page.updatedAt = stamp;
        live().forEach((i) => { if (i.pinned) i.position += 1; });
        const item = {
          id: nextItem++,
          pageId: page.id,
          content: String(args.snippet).trim(),
          projectId: args.projectId,
          createdAt: stamp,
          updatedAt: stamp,
          pinned: true,
          position: 0,
          doneAt: null,
          deletedAt: null,
        };
        items.push(item);
        lastProjectId = args.projectId;
        return { item: outItem(item), page: pageOut(page) };
      }
      case "undo_commit": {
        const item = items.find((i) => i.id === args.itemId);
        if (!item || item.updatedAt !== item.createdAt) throw new Error("snippet edited");
        const page = pages.find((p) => p.id === item.pageId);
        if (!page || page.revision !== args.expectedRevision) throw new Error("page changed");
        page.content = args.pageContentBefore;
        page.revision += 1;
        page.updatedAt = now();
        items.splice(items.indexOf(item), 1);
        return pageOut(page);
      }
      case "update_item": {
        const item = items.find((i) => i.id === args.id);
        item.content = String(args.content).trim();
        item.updatedAt = now();
        return outItem(item);
      }
      case "extract_item_to_page": {
        const item = items.find((i) => i.id === args.itemId);
        if (!item || item.deletedAt) throw new Error("missing item");
        const page = pages.find((p) => p.id === args.pageId);
        if (!page || page.revision !== args.expectedRevision) throw new Error("stale page");
        page.content = args.pageContent;
        page.revision += 1;
        page.updatedAt = now();
        item.deletedAt = now();
        return { page: pageOut(page), item: outItem(item) };
      }
      case "undo_extract_item_to_page": {
        const item = items.find((i) => i.id === args.itemId);
        if (!item || !item.deletedAt) throw new Error("item is not deleted");
        const page = pages.find((p) => p.id === args.pageId);
        if (!page || page.revision !== args.expectedRevision) throw new Error("stale page");
        page.content = args.pageContentBefore;
        page.revision += 1;
        page.updatedAt = now();
        item.deletedAt = null;
        return { page: pageOut(page), item: outItem(item) };
      }
      case "set_done": {
        const item = items.find((i) => i.id === args.id);
        item.doneAt = args.done ? now() : null;
        return outItem(item);
      }
      case "set_pinned": {
        const item = items.find((i) => i.id === args.id);
        if (args.pinned && !item.pinned) {
          live().forEach((i) => { if (i.pinned) i.position += 1; });
          item.position = 0;
        }
        item.pinned = args.pinned;
        return outItem(item);
      }
      case "move_item": {
        const item = items.find((i) => i.id === args.id);
        item.projectId = args.projectId;
        return outItem(item);
      }
      case "reorder_board":
        args.orderedIds.forEach((id, position) => {
          const item = items.find((i) => i.id === id);
          if (item) item.position = position;
        });
        return undefined;
      case "delete_item": {
        const item = items.find((i) => i.id === args.id);
        item.deletedAt = now();
        return undefined;
      }
      case "restore_item": {
        const item = items.find((i) => i.id === args.id);
        item.deletedAt = null;
        return outItem(item);
      }
      case "query_items": {
        let results = args.archive ? live() : live().filter((i) => i.pinned);
        if (args.inboxOnly) results = results.filter((i) => i.projectId === null);
        else if (args.projectId !== null) results = results.filter((i) => i.projectId === args.projectId);
        if (!args.includeDone) results = results.filter((i) => i.doneAt === null);
        if (args.query) {
          const needle = String(args.query).toLowerCase();
          results = results.filter((i) => i.content.toLowerCase().includes(needle));
        }
        return results.sort(args.archive ? byCreated : byPosition).map(outItem);
      }
      case "create_project": {
        const name = String(args.name).trim();
        const existing = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (existing) return clone(existing);
        const project = { id: nextProject++, name };
        projects.push(project);
        return clone(project);
      }
      case "rename_project": {
        const project = projects.find((p) => p.id === args.id);
        if (projects.some((p) => p.id !== args.id && p.name.toLowerCase() === String(args.name).toLowerCase())) {
          throw new Error("duplicate project");
        }
        project.name = String(args.name).trim();
        return clone(project);
      }
      case "delete_project": {
        items.forEach((i) => { if (i.projectId === args.id) i.projectId = null; });
        const index = projects.findIndex((p) => p.id === args.id);
        projects.splice(index, 1);
        return undefined;
      }
      case "hide_window":
      case "quit_now":
        return undefined;
      case "open_external_link":
        window.__mock.links.push(String(args.url));
        return undefined;
      default:
        throw new Error("Unknown command: " + cmd);
    }
  };

  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name, handler) => {
        (handlers[name] = handlers[name] || []).push(handler);
        return () => {};
      },
    },
  };
  window.__mock = { projects, pages, items, links: [] };
})();`;

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function main() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'",
      });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  const problems = [];
  page.on("pageerror", (error) => problems.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push("console: " + message.text());
  });

  await page.addInitScript({ content: MOCK });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector("#page");
  await page.waitForTimeout(300);

  assert.equal(await page.locator("#board-count").textContent(), "0");
  assert.equal(await page.locator("#page-date").textContent().then((t) => t.length > 0), true);

  // Type, autosave, and commit a selection.
  await page.locator("#page").fill("alpha bravo\ncharlie delta");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const textarea = document.querySelector("#page");
    textarea.focus();
    textarea.setSelectionRange(6, 11);
  });
  await page.keyboard.press("Meta+s");
  await page.waitForSelector("#commit-bar:not([hidden])");
  assert.equal(await page.locator("#commit-preview").textContent(), "bravo");
  assert.equal(await page.locator("#commit-project").inputValue(), "");
  assert.equal(await page.locator("#commit-confirm").textContent(), "Pin to Inbox");
  assert.equal(await page.locator("#commit-suggest li").count(), 1);
  await page.screenshot({ path: "/tmp/snippets-ui-commit.png", fullPage: true });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);

  assert.equal(await page.locator("#page").inputValue(), "alpha \ncharlie delta");
  assert.equal(await page.locator(".card-text").first().textContent().then((text) => text?.trim()), "bravo");
  assert.equal(await page.locator("#toast-text").textContent(), "Pinned to Inbox");
  assert.equal(await page.locator("#board-count").textContent(), "1");
  await page.screenshot({ path: "/tmp/snippets-ui-page.png", fullPage: true });

  // Undo the pin.
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#page").inputValue(), "alpha bravo\ncharlie delta");
  assert.equal(await page.locator("#board-list .card").count(), 0);

  // Pin again, then tick it done.
  await page.evaluate(() => {
    const textarea = document.querySelector("#page");
    textarea.focus();
    textarea.setSelectionRange(6, 11);
  });
  await page.keyboard.press("Meta+s");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(300);
  await page.locator("#board-list .card .tick").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#done-shelf").isVisible(), true);
  await page.locator("#done-toggle").click();
  assert.equal(await page.locator("#done-list .card-text").first().textContent().then((text) => text?.trim()), "bravo");
  await page.screenshot({ path: "/tmp/snippets-ui-done.png", fullPage: true });

  // A done snippet can also go back to the page with the p shortcut.
  await page.locator("#done-list .card").focus();
  await page.keyboard.press("p");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "alpha bravo\ncharlie delta");
  assert.equal(await page.locator("#done-shelf").isHidden(), true);
  assert.equal(await page.locator("#toast-text").textContent(), "Returned to page");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "alpha \ncharlie delta");
  assert.equal(await page.locator("#done-list .card").count(), 1);
  assert.equal(await page.locator("#done-shelf").isVisible(), true);

  // Unpin the done item.
  await page.locator("#done-list .card [data-action=unpin]").click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#done-shelf").isHidden(), true);
  assert.equal(await page.locator("#toast-text").textContent(), "Unpinned");

  // Archive search.
  await page.keyboard.press("Meta+f");
  await page.waitForSelector("#archive:not([hidden])");
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".archive-text").first().textContent().then((text) => text?.trim()), "bravo");
  await page.screenshot({ path: "/tmp/snippets-ui-archive.png", fullPage: true });

  await page.locator("#archive-search").fill("zzz");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#archive-body .archive-empty").isVisible(), true);
  await page.locator("#archive-search").fill("bravo");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".archive-text").count(), 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#archive").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#archive").isHidden(), true);

  // Create a project by typing a new name in the commit bar.
  await page.evaluate(() => {
    const textarea = document.querySelector("#page");
    textarea.focus();
    textarea.setSelectionRange(7, 20);
  });
  await page.keyboard.press("Meta+s");
  await page.locator("#commit-project").fill("RQA");
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".suggest li.is-create").count(), 1);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#board-list .card-text").first().textContent().then((text) => text?.trim()), "charlie delta");
  assert.equal(await page.locator("#board-list .card-project").first().textContent(), "RQA");
  assert.equal(await page.locator("#toast-text").textContent(), "Pinned to RQA");
  await page.screenshot({ path: "/tmp/snippets-ui-project.png", fullPage: true });

  // Inline edit.
  await page.locator("#board-list .card-text").first().click();
  await page.locator("#board-list .card-edit").fill("charlie delta edited");
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#board-list .card-text").first().textContent().then((text) => text?.trim()), "charlie delta edited");

  // The picker lists every project; arrows choose one, Enter pins.
  await page.locator("#page").fill("delta echo");
  await page.evaluate(() => {
    const textarea = document.querySelector("#page");
    textarea.focus();
    textarea.setSelectionRange(6, 10);
  });
  await page.keyboard.press("Meta+s");
  await page.waitForSelector("#commit-bar:not([hidden])");
  assert.equal(await page.locator("#commit-project").inputValue(), "");
  assert.equal(await page.locator("#commit-confirm").textContent(), "Pin to Inbox");
  assert.equal(await page.locator("#commit-suggest li").count(), 2);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#commit-confirm").textContent(), "Pin to RQA");
  await page.screenshot({ path: "/tmp/snippets-ui-picker.png", fullPage: true });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#toast-text").textContent(), "Pinned to RQA");
  assert.equal(await page.locator("#board-list .card-project").first().textContent(), "RQA");

  // Project manager rename and delete.
  await page.keyboard.press("Meta+f");
  await page.waitForTimeout(300);
  await page.locator("#manage-projects").click();
  assert.equal(await page.locator("#project-list li").count(), 1);
  await page.screenshot({ path: "/tmp/snippets-ui-projects.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // New page and page picker.
  await page.keyboard.press("Meta+n");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "");
  await page.keyboard.press("Meta+p");
  await page.waitForSelector("#pages:not([hidden])");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".page-row").count(), 2);
  assert.equal(await page.locator(".page-row-badge").count(), 1);
  await page.screenshot({ path: "/tmp/snippets-ui-pages.png", fullPage: true });
  await page.locator(".page-row").nth(1).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#page").inputValue(), "delta ");

  // Return a board snippet with the p shortcut; undo restores both.
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.locator("#board-list .card").first().focus();
  await page.keyboard.press("p");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "delta echo");
  assert.equal(await page.locator("#board-count").textContent(), "1");
  assert.equal(await page.locator("#toast-text").textContent(), "Returned to page");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "delta ");
  assert.equal(await page.locator("#board-count").textContent(), "2");

  // Return from the archive: overlay stays open, page updates behind it.
  // The caret is at the start, so closing must preserve the insertion point.
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, 0);
  });
  await page.keyboard.press("Meta+f");
  await page.waitForSelector("#archive:not([hidden])");
  await page.waitForTimeout(300);
  await page.locator("#archive-body .archive-row").first().hover();
  await page.locator("#archive-body .archive-row [data-action=to-page]").first().click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#archive").isVisible(), true);
  assert.equal(await page.locator("#page").inputValue(), "echodelta ");
  assert.equal(await page.locator("#board-count").textContent(), "1");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#archive").isHidden(), true);
  assert.equal(
    await page.locator("#page").evaluate((element) => element.selectionStart),
    4,
    "closing the archive should preserve the insertion caret",
  );
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#page").inputValue(), "delta ");
  assert.equal(await page.locator("#board-count").textContent(), "2");

  // Returning replaces a page selection exactly.
  await page.locator("#page").fill("left right");
  await page.waitForTimeout(300);
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, 4);
  });
  await page.locator("#board-list .card").first().focus();
  await page.keyboard.press("p");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "echo right");
  assert.equal(await page.locator("#board-count").textContent(), "1");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "left right");
  assert.equal(await page.locator("#board-count").textContent(), "2");

  // If the page changes before Undo, only the snippet is restored.
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.locator("#board-list .card").first().focus();
  await page.keyboard.press("p");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#page").inputValue(), "left rightecho");
  await page.locator("#page").fill("left rightecho changed");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#page").inputValue(), "left rightecho changed");
  assert.equal(await page.locator("#board-count").textContent(), "2");
  assert.equal(
    await page.locator("#toast-text").textContent(),
    "Snippet restored; the page had changed",
  );

  // Pin, then type before Undo: the typing must not be clobbered.
  await page.locator("#page").fill("guard me");
  await page.waitForTimeout(300);
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, element.value.length);
  });
  await page.keyboard.press("Meta+s");
  await page.waitForSelector("#commit-bar:not([hidden])");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#board-count").textContent(), "3");
  await page.locator("#page").fill("typed after");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#page").inputValue(), "typed after");
  assert.equal(await page.locator("#board-count").textContent(), "3");
  assert.equal(
    await page.locator("#toast-text").textContent(),
    "The page has changed; the pin was not undone",
  );

  // Page Read mode: Markdown, tables and external links.
  const markdownSource =
    "# Heading\n\n**bold** and *italic* and `code`\n\n[OpenAI](https://openai.com) and www.example.com\n\n[www](www.example.com) [bad](javascript:alert(1))\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |";
  await page.locator("#page").fill(markdownSource);
  await page.waitForTimeout(350);
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#page").isHidden(), true);
  assert.equal(await page.locator("#page-rendered").isVisible(), true);
  assert.equal(await page.locator("#page-rendered h1").textContent(), "Heading");
  assert.equal(await page.locator("#page-rendered strong").textContent(), "bold");
  assert.equal(await page.locator("#page-rendered em").textContent(), "italic");
  assert.equal(await page.locator("#page-rendered code").first().textContent(), "code");
  assert.equal(await page.locator("#page-rendered table").count(), 1);
  const wwwLink = page.getByRole("link", { name: "www", exact: true });
  assert.equal(await wwwLink.count(), 1);
  assert.ok(
    (await wwwLink.getAttribute("href"))?.startsWith("https://www.example.com"),
    "www links should normalize to https",
  );
  const linksBefore = await page.evaluate(() => window.__mock.links.length);
  await page.locator("#page-rendered a[href*='openai.com']").click();
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => window.__mock.links.length),
    linksBefore + 1,
    "external link should be opened",
  );
  assert.ok(
    (await page.evaluate(() => window.__mock.links[window.__mock.links.length - 1])).includes(
      "openai.com",
    ),
  );
  await page.screenshot({ path: "/tmp/snippets-ui-read.png", fullPage: true });

  // Cmd+S in Read mode returns to Edit without pinning.
  await page.keyboard.press("Meta+s");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#page").isVisible(), true);
  assert.equal(await page.locator("#commit-bar").isHidden(), true);
  assert.equal(await page.locator("#page").inputValue(), markdownSource);

  // The Read button and Esc toggle the same mode.
  await page.locator("#toggle-read").click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#page-rendered").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#page").isVisible(), true);

  // Sanitizing: scripts, images, styles and javascript: links are removed.
  await page.locator("#page").fill(
    "<script>window.__pwned=1</script>\n<img src=x onerror=\"window.__pwned=2\">\n<div style=\"color:red\">styled</div>\n<a href=\"javascript:alert(1)\">bad</a>",
  );
  await page.waitForTimeout(300);
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#page-rendered script").count(), 0);
  assert.equal(await page.locator("#page-rendered img").count(), 0);
  assert.equal(await page.locator("#page-rendered [style]").count(), 0);
  assert.equal(await page.locator("#page-rendered a[href^='javascript']").count(), 0);
  const disabledLink = page.locator("#page-rendered a").filter({ hasText: /^bad$/ });
  assert.equal(await disabledLink.count(), 1);
  assert.equal(await disabledLink.getAttribute("href"), null);
  assert.equal(
    await disabledLink.evaluate((element) => element.classList.contains("is-disabled-link")),
    true,
  );
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(200);

  // Rendered snippets: links open, non-link text still edits.
  await page.locator("#page").fill("keep **bold** and [site](https://example.com)");
  await page.waitForTimeout(350);
  await page.locator("#page").evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, element.value.length);
  });
  await page.keyboard.press("Meta+s");
  await page.waitForSelector("#commit-bar:not([hidden])");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#board-list .card strong").first().textContent(), "bold");
  const cardLinksBefore = await page.evaluate(() => window.__mock.links.length);
  await page.locator("#board-list .card a[href*='example.com']").first().click();
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => window.__mock.links.length),
    cardLinksBefore + 1,
    "card link should be opened",
  );
  assert.equal(await page.locator("#board-list .card-edit").count(), 0, "link click must not edit");
  await page.keyboard.press("Meta+f");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#archive-body strong").first().textContent(), "bold");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // The splitter resizes the rail, persists, and resets on double-click.
  const splitter = page.locator("#splitter");
  const splitterBox = await splitter.boundingBox();
  assert.ok(splitterBox);
  const dragBefore = (await page.locator("#board").boundingBox())?.width ?? 0;
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(
    splitterBox.x + splitterBox.width / 2 - 80,
    splitterBox.y + 120,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.waitForTimeout(120);
  const dragAfter = (await page.locator("#board").boundingBox())?.width ?? 0;
  assert.ok(dragAfter > dragBefore + 60, "pointer drag should widen the board");
  await splitter.dblclick();
  await page.waitForTimeout(120);
  const dragReset = (await page.locator("#board").boundingBox())?.width ?? 0;
  assert.ok(Math.abs(dragReset - 340) < 2, "double-click should reset after a drag");

  const boardBefore = await page.locator("#board").boundingBox();
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(120);
  const boardAfter = await page.locator("#board").boundingBox();
  assert.ok(boardBefore && boardAfter);
  assert.ok(boardAfter.width > boardBefore.width, "splitter should widen the board");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("snippets.railWidth")),
    String(Math.round(boardAfter.width)),
  );
  await splitter.dblclick();
  await page.waitForTimeout(120);
  const boardReset = await page.locator("#board").boundingBox();
  assert.ok(boardReset && Math.abs(boardReset.width - 340) < 2, "double-click should reset the rail");

  // No runtime errors.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/snippets-ui-dark.png", fullPage: true });

  // Layout stress: independent scrolling and a long project list.
  const layout = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    deviceScaleFactor: 1,
  });
  const layoutProblems = [];
  layout.on("pageerror", (error) => layoutProblems.push("pageerror: " + error.message));
  layout.on("console", (message) => {
    if (message.type() === "error") layoutProblems.push("console: " + message.text());
  });
  const projectNames = Array.from({ length: 12 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
  const lines = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join("\n");
  await layout.addInitScript({
    content: `window.__MOCK_ITEMS__=60; window.__MOCK_PROJECTS__=${JSON.stringify(projectNames)}; window.__MOCK_PAGE__=${JSON.stringify(lines)};`,
  });
  await layout.addInitScript({ content: MOCK });
  await layout.goto(`http://127.0.0.1:${port}/`);
  await layout.waitForSelector("#page");
  await layout.waitForTimeout(400);

  const boardList = layout.locator("#board-list");
  const boardMetrics = await boardList.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(boardMetrics.scrollHeight > boardMetrics.clientHeight, "board list should overflow");
  const headBefore = await layout.locator(".board-head").boundingBox();
  await boardList.evaluate((element) => {
    element.scrollTop = 500;
  });
  await layout.waitForTimeout(100);
  assert.ok((await boardList.evaluate((element) => element.scrollTop)) > 0, "board list should scroll");
  const headAfter = await layout.locator(".board-head").boundingBox();
  assert.ok(headBefore && headAfter);
  assert.equal(headAfter.y, headBefore.y, "board header should stay put");

  const pageBox = layout.locator("#page");
  const pageMetrics = await pageBox.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(pageMetrics.scrollHeight > pageMetrics.clientHeight, "page should overflow");
  const dateBefore = await layout.locator("#page-date").boundingBox();
  await pageBox.evaluate((element) => {
    element.scrollTop = 400;
  });
  await layout.waitForTimeout(100);
  assert.ok((await pageBox.evaluate((element) => element.scrollTop)) > 0, "page should scroll");
  const dateAfter = await layout.locator("#page-date").boundingBox();
  assert.ok(dateBefore && dateAfter);
  assert.equal(dateAfter.y, dateBefore.y, "top bar should stay put");

  // The rendered Read view scrolls independently too.
  await layout.keyboard.press("Meta+e");
  await layout.waitForTimeout(250);
  const renderedPage = layout.locator("#page-rendered");
  assert.equal(await renderedPage.isVisible(), true);
  const readMetrics = await renderedPage.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert.ok(readMetrics.scrollHeight > readMetrics.clientHeight, "read view should overflow");
  await renderedPage.evaluate((element) => {
    element.scrollTop = 400;
  });
  await layout.waitForTimeout(100);
  assert.ok(
    (await renderedPage.evaluate((element) => element.scrollTop)) > 0,
    "read view should scroll",
  );
  await layout.keyboard.press("Meta+e");
  await layout.waitForTimeout(200);

  // All projects are listed; arrows scroll the picker; Enter uses the highlight.
  await pageBox.evaluate((element) => {
    element.focus();
    element.setSelectionRange(0, 5);
  });
  await layout.keyboard.press("Meta+s");
  await layout.waitForSelector("#commit-bar:not([hidden])");
  assert.equal(await layout.locator("#commit-project").inputValue(), "");
  assert.equal(await layout.locator("#commit-suggest li").count(), 13);
  assert.equal(await layout.locator("#commit-confirm").textContent(), "Pin to Inbox");
  for (let index = 0; index < 10; index++) {
    await layout.keyboard.press("ArrowDown");
  }
  await layout.waitForTimeout(100);
  assert.equal(await layout.locator("#commit-confirm").textContent(), "Pin to P10");
  assert.ok(
    (await layout.locator("#commit-suggest").evaluate((element) => element.scrollTop)) > 0,
    "project list should scroll",
  );
  await layout.screenshot({ path: "/tmp/snippets-ui-layout.png", fullPage: true });
  await layout.keyboard.press("Home");
  assert.equal(await layout.locator("#commit-confirm").textContent(), "Pin to Inbox");
  await layout.keyboard.press("ArrowDown");
  assert.equal(await layout.locator("#commit-confirm").textContent(), "Pin to P01");
  await layout.keyboard.press("Enter");
  await layout.waitForTimeout(400);
  assert.equal(await layout.locator("#toast-text").textContent(), "Pinned to P01");
  if (layoutProblems.length > 0) {
    throw new Error("Layout runtime errors:\n" + layoutProblems.join("\n"));
  }
  await layout.close();

  await page.waitForTimeout(300);
  const unexpectedProblems = problems.filter(
    (message) =>
      !message.includes(
        "inline event handler violates the following Content Security Policy",
      ),
  );
  if (unexpectedProblems.length > 0) {
    throw new Error("Runtime errors:\n" + unexpectedProblems.join("\n"));
  }

  console.log("UI flow passed");
  await browser.close();
  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
