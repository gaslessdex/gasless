export const SCENE_SPEED = 31;

export function sceneVelocity(slowed: boolean, reducedMotion = false) {
  if (reducedMotion) return 0;
  return SCENE_SPEED * (slowed ? 0.22 : 1);
}
