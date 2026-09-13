#!/usr/bin/env bash
# Build the pinned Slice backend locally; preserve upstream sources and licenses.
set -euo pipefail

if [[ $# != 1 || $1 != /* ]]; then
  printf 'Usage: bash scripts/build-slice.sh /absolute/new-directory\n' >&2
  exit 2
fi
for command in git cmake; do
  command -v "$command" >/dev/null || { printf 'Missing prerequisite: %s\n' "$command" >&2; exit 1; }
done

readonly revision=d90acb2cb3295da8ca0fd33a88e81cb51a8575fb
# mkdir refuses existing files/directories/symlinks. A failed build is retained
# for diagnosis; never overwrite or remove a caller's checkout.
mkdir -- "$1"
destination=$(cd -- "$1" && pwd -P)
git -C "$destination" init --quiet
git -C "$destination" remote add origin https://github.com/redhat-et/ripwire.git
git -C "$destination" -c core.hooksPath=/dev/null fetch --depth=1 origin "$revision"
git -C "$destination" -c core.hooksPath=/dev/null checkout --quiet --detach FETCH_HEAD
test "$(git -C "$destination" rev-parse HEAD)" = "$revision"

cmake -S "$destination" -B "$destination/build" \
  -DCMAKE_BUILD_TYPE=Release -DRIPWIRE_LTO=OFF -DRIPWIRE_NATIVE=OFF \
  -DFETCHCONTENT_FULLY_DISCONNECTED=ON
cmake --build "$destination/build" --target ripwire --parallel 2
test -x "$destination/build/ripwire"
printf '\nSlice backend built: %s/build/ripwire\n' "$destination"
printf 'Source and licenses retained in: %s\n' "$destination"
