# Minimal /usr/sbin/helper.sh of Asuswrt-Merlin: addon settings in /jffs/addons/custom_settings.txt
SETTINGSFILE=/jffs/addons/custom_settings.txt
am_settings_get() {
    grep "^$1 " "$SETTINGSFILE" 2>/dev/null | head -n 1 | cut -f2- -d' '
}
am_settings_set() {
    touch "$SETTINGSFILE"
    grep -v "^$1 " "$SETTINGSFILE" >"$SETTINGSFILE.tmp"
    [ -n "$2" ] && printf '%s %s\n' "$1" "$2" >>"$SETTINGSFILE.tmp"
    mv "$SETTINGSFILE.tmp" "$SETTINGSFILE"
}
