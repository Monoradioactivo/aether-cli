import { platformMismatchWarnings, platformsNamedByAppName } from "../../script/utils/app-name-platform";

describe("platformsNamedByAppName", () => {
  it.each([
    ["MyApp-iOS", ["ios"]],
    ["MyApp-Android", ["android"]],
    ["myapp_ios", ["ios"]],
    ["ios.myapp", ["ios"]],
    ["iOS", ["ios"]],
    ["MyAppiOS", ["ios"]],
    ["MyAppIOS", ["ios"]],
    ["MyApp2IOS", ["ios"]],
    ["MyAppiOSBeta", ["ios"]],
    ["MyAppIos", ["ios"]],
    ["iOSMyApp", ["ios"]],
    ["MyApp-iOSBeta", ["ios"]],
    ["MyApp_iOSStaging", ["ios"]],
    ["MyApp-iOS17", ["ios"]],
    ["MyAppAndroid", ["android"]],
    ["myapp-android-beta", ["android"]],
    ["ANDROID", ["android"]],
  ])("reads %s as naming %j", (appName, expected) => {
    expect(platformsNamedByAppName(appName)).toEqual(expected);
  });

  it.each(["MyApp", "Studios", "Radios", "RADIOS", "BIOS", "BiosTracker", "my-react-native-app", "MyAppiOSphere", "MyAppIosk"])(
    "reads %s as naming no platform",
    (appName) => {
      expect(platformsNamedByAppName(appName)).toEqual([]);
    }
  );

  it.each(["MyApp-iOS-Android", "MyAppIosAndroid"])("reads %s as naming both platforms", (appName) => {
    expect(platformsNamedByAppName(appName)).toEqual(["ios", "android"]);
  });
});

describe("platformMismatchWarnings", () => {
  it("stays quiet when the app name names the release platform", () => {
    expect(platformMismatchWarnings("MyApp-iOS", "Staging", "ios")).toBeNull();
    expect(platformMismatchWarnings("MyApp-Android", "Production", "android")).toBeNull();
  });

  it("warns before and after the release when the app name names the other platform", () => {
    const warnings = platformMismatchWarnings("MyApp-Android", "Production", "ios");
    expect(warnings?.beforeRelease).toBe(
      'Warning: the app name "MyApp-Android" names Android, but this release is bundled for iOS. ' +
        "Android devices on this app's deployment key whose binary version matches would download an iOS bundle. " +
        "The release continues."
    );
    expect(warnings?.afterRelease("v7")).toBe(
      'Warning: this iOS bundle went to "MyApp-Android" as v7, and the app\'s name names Android. ' +
        'If that was a mistake, disable it with `aether patch "MyApp-Android" "Production" --label v7 -x` ' +
        "so devices stop downloading it, then release the matching bundle."
    );
  });

  it("warns for an Android bundle released to an iOS-named app", () => {
    expect(platformMismatchWarnings("MyApp-iOS", "Staging", "android")?.beforeRelease).toContain(
      'the app name "MyApp-iOS" names iOS, but this release is bundled for Android.'
    );
  });

  it("stays quiet when the app name names no platform, as on an app's first release", () => {
    expect(platformMismatchWarnings("MyApp", "Staging", "ios")).toBeNull();
    expect(platformMismatchWarnings("MyApp", "Staging", "android")).toBeNull();
  });

  it("stays quiet when the app name names both platforms", () => {
    expect(platformMismatchWarnings("MyApp-iOS-Android", "Staging", "ios")).toBeNull();
    expect(platformMismatchWarnings("MyApp-iOS-Android", "Staging", "android")).toBeNull();
  });
});
