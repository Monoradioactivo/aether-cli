export type ReleasePlatform = "ios" | "android";

const ANDROID_IN_NAME = /android/i;
const IOS_AS_SEPARATE_WORD = /(?:^|[^a-z0-9])ios(?:$|[^a-z0-9])/i;
const IOS_CASED_NOT_AFTER_CAPITAL = /(?:^|[^A-Z])(?:iOS|IOS)(?![a-z])/;
const IOS_CAPITALIZED_AFTER_LOWERCASE_OR_DIGIT = /[a-z0-9]Ios(?![a-z])/;

const PLATFORM_LABELS: Record<ReleasePlatform, string> = { ios: "iOS", android: "Android" };

export interface PlatformMismatchWarnings {
  beforeRelease: string;
  afterRelease: (releasedLabel: string) => string;
}

export function platformsNamedByAppName(appName: string): ReleasePlatform[] {
  const named: ReleasePlatform[] = [];
  if (
    IOS_AS_SEPARATE_WORD.test(appName) ||
    IOS_CASED_NOT_AFTER_CAPITAL.test(appName) ||
    IOS_CAPITALIZED_AFTER_LOWERCASE_OR_DIGIT.test(appName)
  ) {
    named.push("ios");
  }
  if (ANDROID_IN_NAME.test(appName)) {
    named.push("android");
  }
  return named;
}

export function platformMismatchWarnings(
  appName: string,
  deploymentName: string,
  platform: ReleasePlatform
): PlatformMismatchWarnings | null {
  const named = platformsNamedByAppName(appName);
  if (named.length !== 1 || named[0] === platform) {
    return null;
  }
  const appPlatform = PLATFORM_LABELS[named[0]];
  const bundlePlatform = PLATFORM_LABELS[platform];
  return {
    beforeRelease:
      `Warning: the app name "${appName}" names ${appPlatform}, but this release is bundled for ${bundlePlatform}. ` +
      `${appPlatform} devices on this app's deployment key whose binary version matches would download an ${bundlePlatform} bundle. ` +
      `The release continues.`,
    afterRelease: (releasedLabel: string) =>
      `Warning: this ${bundlePlatform} bundle went to "${appName}" as ${releasedLabel}, and the app's name names ${appPlatform}. ` +
      `If that was a mistake, disable it with \`aether patch "${appName}" "${deploymentName}" --label ${releasedLabel} -x\` ` +
      `so devices stop downloading it, then release the matching bundle.`,
  };
}
