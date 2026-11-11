import type { PoseState } from "./head-pose";

export const FACEPP_LOGIN_SIDE_MIN_YAW = 35;
export const FACEPP_LOGIN_SIDE_STABLE_READS = 6;

export function isFacePlusPlusLoginSidePoseReady(
  stage: "left" | "right",
  state: PoseState
): boolean {
  return (
    state.pose === stage &&
    (stage === "left"
      ? state.yaw >= FACEPP_LOGIN_SIDE_MIN_YAW
      : state.yaw <= -FACEPP_LOGIN_SIDE_MIN_YAW)
  );
}
