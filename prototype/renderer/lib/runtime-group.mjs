export function workspaceGroupToRuntimeGroup(group = {}, maxRounds, mutedSeatIds = [], workMode = "collab") {
  const muted = new Set(mutedSeatIds)
  const seats = (group.seats || group.agents || []).filter(Boolean)
  return {
    id: group.id || "ui-runtime-council",
    name: group.name || group.groupFolderName || "AI Council",
    settings: {
      ...(group.settings || {}),
      allowSoloCouncil: seats.filter((seat, index) => {
        const id = seat.seatId || seat.id || "seat_" + String(index + 1).padStart(2, "0")
        return seat.enabled !== false && !muted.has(id)
      }).length === 1,
      maxRounds,
      workMode,
    },
    agents: seats.map((seat, index) => {
      const id = seat.seatId || seat.id || "seat_" + String(index + 1).padStart(2, "0")
      const baseUrl = seat.apiUrl || seat.apiBaseUrl || ""
      const apiKey = seat.apiKey || ""
      const reviewer = Boolean(seat.reviewer || seat.mandatoryRedTeam)
      const judge = Boolean(seat.judge)
      return {
        id,
        name: seat.displayName || seat.name || (judge ? "summarizer" : reviewer ? "reviewer" : id),
        role: reviewer ? "reviewer" : judge ? "summarizer" : runtimeRole(seat, id),
        team: seat.team || "",
        provider: providerForSeat(seat.providerPreset, baseUrl, apiKey),
        providerPreset: seat.providerPreset || inferProviderPreset(baseUrl),
        apiBaseUrl: baseUrl || "mock://local",
        apiKey,
        model: seat.model || seat.currentModel || "mock-builder",
        reasoningEffort: seat.reasoningEffort || "",
        weight: Number(seat.weight || 1),
        enabled: seat.enabled !== false && !muted.has(id),
        reviewer,
        mandatoryRedTeam: reviewer,
        judge,
        ...(reviewer ? { reviewIntensity: seat.reviewIntensity === 1 || seat.reviewIntensity === 3 ? seat.reviewIntensity : 2 } : {}),
      }
    }),
  }
}

function runtimeRole(seat, id) {
  const raw = String(seat.role || "").trim()
  if (["reviewer", "summarizer", "judge", "red team"].includes(raw.toLowerCase())) {
    return seat.team || seat.displayName || seat.name || id
  }
  return raw || seat.team || seat.displayName || seat.name || id
}

function inferProviderPreset(baseUrl = "") {
  const lower = baseUrl.toLowerCase()
  if (lower.includes("anthropic.com")) return "anthropic"
  if (lower.includes("deepseek")) return "deepseek"
  if (lower.includes("openrouter")) return "openrouter"
  if (lower.includes("localhost") || lower.includes("11434")) return "ollama"
  return "custom"
}

function providerForSeat(providerPreset = "", baseUrl = "", apiKey = "") {
  if (!baseUrl) return "mock"
  const preset = providerPreset || inferProviderPreset(baseUrl)
  if (!apiKey && !["ollama", "lmstudio", "vllm-local"].includes(preset)) return "mock"
  return preset === "anthropic" ? "anthropic-messages" : "openai-compatible"
}
