/** The flag requests a private build; it must never fall back to a normal profile. */
export function hasQualificationLaunchArgument(argv: readonly string[]): boolean {
  const flag = '--aibrowse-watch-resource-qualification';
  return argv.some((value) => value === flag || value.startsWith(`${flag}=`));
}
