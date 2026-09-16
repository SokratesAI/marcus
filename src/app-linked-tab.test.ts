import { describe, it, expect } from "vitest";
import { renderApp } from "./app-dom.js";

// The 20:00 reminder's notification links to `/#plan`, and boot opened Home
// whatever the address said. These run the real switchTab in the real shell.
function activeTab(app: any): string | undefined {
  return app.document.querySelector(".bottomnav__item.is-active")?.dataset.tab;
}

function fakeServiceWorker() {
  const listeners: Array<(e: any) => void> = [];
  return {
    addEventListener: (name: string, fn: (e: any) => void) => { if (name === "message") listeners.push(fn); },
    send: (data: unknown) => listeners.forEach((fn) => fn({ data })),
  };
}

describe("linkedTab", () => {
  it("reads a tab name after the #", () => {
    const app = renderApp("home");
    expect(app.window.linkedTab("/#plan")).toBe("plan");
    expect(app.window.linkedTab("https://marcus.example/#Progress")).toBe("progress");
    app.close();
  });

  it("names no tab for a link without one", () => {
    const app = renderApp("home");
    for (const link of ["/", "", undefined, "/#", "/#settings", "/plan"]) {
      expect(app.window.linkedTab(link)).toBeNull();
    }
    app.close();
  });
});

describe("boot", () => {
  it("opens the tab the reminder's link names", () => {
    const app = renderApp("", {}, { url: "https://marcus.test/#plan" });
    expect(activeTab(app)).toBe("plan");
    app.close();
  });

  it("opens Home from the bare address", () => {
    const app = renderApp("", {}, { url: "https://marcus.test/" });
    expect(activeTab(app)).toBe("home");
    app.close();
  });
});

describe("openLinkedTab", () => {
  it("opens the tab the address names at boot", () => {
    const app = renderApp("home");
    app.window.openLinkedTab({ location: { hash: "#plan" } });
    expect(activeTab(app)).toBe("plan");
    app.close();
  });

  it("opens Home when the address names no tab", () => {
    const app = renderApp("log");
    app.window.openLinkedTab({ location: { hash: "#nope" } });
    expect(activeTab(app)).toBe("home");
    app.close();
  });

  it("switches an already open app when the service worker hands it a link", () => {
    const app = renderApp("home");
    const sw = fakeServiceWorker();
    app.window.openLinkedTab({ location: { hash: "" }, navigator: { serviceWorker: sw } });
    app.window.switchTab("log");
    sw.send({ type: "open-link", navigate: "/#plan" });
    expect(activeTab(app)).toBe("plan");
    app.close();
  });

  it("stays put on a message that names no tab or is not a link", () => {
    const app = renderApp("home");
    const sw = fakeServiceWorker();
    app.window.openLinkedTab({ location: { hash: "" }, navigator: { serviceWorker: sw } });
    app.window.switchTab("log");
    sw.send({ type: "open-link", navigate: "/" });
    sw.send({ type: "something-else", navigate: "/#plan" });
    expect(activeTab(app)).toBe("log");
    app.close();
  });
});
