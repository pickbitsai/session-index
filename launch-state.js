(function attachSessionIndexLaunchState(globalObject) {
  const messages = Object.freeze({
    loading: "Checking whether relaunching is available...",
    unreachable: "The local server is not reachable, so sessions cannot be relaunched from here. Copy the commands instead.",
    stale: "The local server is running an older build. Restart it (npm start) to enable relaunching.",
    off: "Launching is disabled (SESSION_LAUNCH=off). Copy the commands instead.",
  });

  function classifyLaunchAvailability({ configReachable, launchToken, launchMode } = {}) {
    if (!configReachable) return "unreachable";
    if (typeof launchToken !== "string" || !launchToken) return "stale";
    if (launchMode === "off") return "off";
    return "available";
  }

  function launchUnavailableMessage(availability) {
    return messages[availability] || messages.unreachable;
  }

  globalObject.SessionIndexLaunchState = Object.freeze({
    classifyLaunchAvailability,
    launchUnavailableMessage,
  });
})(globalThis);
