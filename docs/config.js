function isLocalFrontend() {
  // If you open the HTML directly from disk (file://...), treat as local dev.
  if (window.location.protocol === "file:") return true;

  const h = (window.location.hostname || "").toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h.endsWith(".local")
  );
}
console.log(`Running locally: ${isLocalFrontend()}`);
window.BACKEND_BASE = isLocalFrontend()
  ? "http://127.0.0.1:8080"
  : "https://ptg-182094629282.europe-west1.run.app";
