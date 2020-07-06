ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

const ARCHIBALD_CLASS_ID=Components.ID("{A6021868-82C4-475a-831B-EB5022282179}");
const ARCHIBALD_CLASS_DESC="Extension Archibald du gestionnaire des comptes";
const ARCHIBALD_CONTRACT_ID="@mozilla.org/accountmanager/extension;1?name=archibald";

function ArchibaldAccManExtension(){

}

ArchibaldAccManExtension.prototype={

  name : "archibald",
  
  chromePackageName : "archibald",
  
  showPanel : function (server){
  
    return ("imap"==server.type || "pop3"==server.type || "none"==server.type);
  },
  
  QueryInterface: XPCOMUtils.generateQI([
    Components.interfaces.nsIMsgAccountManagerExtension
  ])
}

ArchibaldAccManExtension.prototype.classID = Components.ID(ARCHIBALD_CLASS_ID);
ArchibaldAccManExtension.prototype.classDescription = ARCHIBALD_CLASS_DESC;
ArchibaldAccManExtension.prototype.contractID = ARCHIBALD_CONTRACT_ID;


var components = [ArchibaldAccManExtension];
const NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
