#!/bin/bash 

ZIPNAME="pop-launcher-super-key@icesx.zip"

rm -rf $ZIPNAME

zip $ZIPNAME metadata.json extension.js stylesheet.css \
    schemas/org.gnome.shell.extensions.pop-launcher-super-key-icesx.gschema.xml
