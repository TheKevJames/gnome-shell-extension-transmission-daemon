gnome-shell-extension-transmission-daemon
=========================================

This is a Gnome Shell extension for monitoring a transmission-daemon or GTK app
using its RPC interface.

This extension supports Gnome Shell DE from version 3.34.

All credit for this project goes to the original author, Jean-Philippe Braun
(`@eonpatapon`_). This project was forked since maintainance has been abandoned.

Installation
------------

Via extensions.gnome.org
~~~~~~~~~~~~~~~~~~~~~~~~

Visit the `GNOME Extensions Page`_.

Manual
~~~~~~

.. code-block:: console

    $ git clone git://github.com/thekevjames/gnome-shell-extension-transmission-daemon.git
    $ cd gnome-shell-extension-transmission-daemon
    $ make install

If you have ``gnome-shell-devel`` installed, the extension will start working
immediately. If not, restart the shell (atf-f2, type "r") to enable it.

Older Versions of Gnome Shell
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The best way to find the correct version to install for support for older Gnome
Shell versions is to check the `GNOME Extensions Page`_ under the ``Versions``
header. All previously released versions should be accessible as zipfile
downloads there.

Some older versions have been tagged in this repo:

* the latest version supporting ``gnome-shell`` < 3.10 is tag 1.0.0
* the latest version supporting ``gnome-shell`` < 3.16 is tag 2.0.0
* the latest version supporting ``gnome-shell`` < 3.20 is tag 3.0.0

To install for those versions of ``gnome-shell``, please follow the manual
process outlined above after checking out one of the above tags.

Configuration
-------------

You must enable the RPC interface in your transmission settings.

* for the GTK application, see preferences->remote.
* for ``transmission-daemon``, see ``/etc/transmission-daemon/settings.json``.
  Documentation for this file is on the `Transmission wiki`_.

Pretty Pictures
---------------

.. image:: docs/screenshot.png
   :alt: Screenshot
.. image:: docs/screenshot-add.png
   :alt: Add Torrents
.. image:: docs/screenshot-filter.png
   :alt: Filter Torrents by State

.. _@eonpatapon: https://github.com/eonpatapon
.. _GNOME Extensions Page: https://extensions.gnome.org/extension/365/transmission-daemon-indicator/
.. _Transmission wiki: https://github.com/transmission/transmission/wiki/Editing-Configuration-Files
