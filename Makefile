NAME := transmission-daemon@patapon.info
EXTDIR := ~/.local/share/gnome-shell/extensions
ZIPFILE := dist/extension.zip

LOCALES_SRC := $(wildcard ${NAME}/locale/*/LC_MESSAGES/*.po)
LOCALES_DST := $(patsubst %.po,%.mo,$(LOCALES_SRC))


all: build


clean:
	rm -f ${NAME}/schemas/gschemas.compiled
	rm -f ${LOCALES_DST}
	rm -f ${ZIPFILE}

build: ${ZIPFILE}

install: ${EXTDIR}/${NAME}
${EXTDIR}/${NAME}: ${NAME}/schemas/gschemas.compiled ${LOCALES_DST} ${NAME} Makefile
	cp -r ${NAME} ${EXTDIR}/${NAME}
	gnome-extensions enable ${NAME}

reinstall: uninstall install

uninstall:
	gnome-extensions disable ${NAME}
	rm -r ${EXTDIR}/${NAME}

%.mo: %.po
	msgfmt $< -o $@

${NAME}/schemas/gschemas.compiled: ${NAME}/schemas/org.gnome.shell.extensions.transmission-daemon.gschema.xml
	glib-compile-schemas ${NAME}/schemas

${ZIPFILE}: ${NAME}/schemas/gschemas.compiled ${LOCALES_DST} ${NAME} Makefile
	mkdir -p dist
	rm -f ${ZIPFILE}
	cd ${NAME} && zip -qr ../${ZIPFILE} *
