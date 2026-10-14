export { activityJob, activityTitle, activitySummary, activityMatches } from "../../activities.js";

// Hash history keeps the route in the URL fragment, so a notification can open an activity
// without the state provider having to reach into the router it lives above.
export function openActivity(id: string) {
  window.location.hash = `/activities?id=${encodeURIComponent(id)}`;
}
