export interface ScalpingControlsView {
  running: boolean;
  startDisabled: boolean;
  pauseDisabled: boolean;
  stopDisabled: boolean;
  startLabel: "Start" | "Running";
  pauseLabel: "Pause" | "Paused";
}

export function scalpingControlState(status: string, emergencyStop: boolean): ScalpingControlsView {
  const running = status === "running";
  const paused = status === "paused";
  return {
    running,
    startDisabled: running || emergencyStop,
    pauseDisabled: !running,
    stopDisabled: status === "stopped" || emergencyStop,
    startLabel: running ? "Running" : "Start",
    pauseLabel: paused ? "Paused" : "Pause",
  };
}
