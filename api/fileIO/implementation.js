"use strict";

const { ExtensionCommon } = ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm");
const { IOUtils } = ChromeUtils.import("resource://gre/modules/IOUtils.jsm");
const { FilePicker } = ChromeUtils.import("resource://gre/modules/FilePicker.jsm");

this.fileIO = class extends ExtensionCommon.ExtensionAPIPersistent {
  getAPI(context) {
    return {
      fileIO: {
        async createFile(path, content) {
          console.log(`write called with path: ${path}`);
          try {
            await IOUtils.writeUTF8(path, content);
            console.log("write succeeded");
          } catch (e) {
            console.error("write failed:", e);
            throw e;
          }
        },

        async chooseFolder() {
          return new Promise((resolve) => {
            let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
            picker.init(window, "Choose a folder", Ci.nsIFilePicker.modeGetFolder);
            picker.open(rv => {
              if (rv === Ci.nsIFilePicker.returnOK) {
                resolve(picker.file.path);
              } else {
                resolve(null);
              }
            });
          });
        }
      }
    };
  }
};