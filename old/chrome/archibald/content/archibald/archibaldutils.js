
ChromeUtils.import("resource://gre/modules/Services.jsm");


//liste des chaines archibald.properties
var g_messages_archibald=null;

/*
* Retourne une chaîne de message à partir de son identifiant dans le fichie archibald.properties
*/
function ArchibaldMessageFromId(msgid){
  
  if (null==g_messages_archibald)
    g_messages_archibald=Services.strings.createBundle("chrome://archibald/locale/archibald.properties");
  
  return g_messages_archibald.GetStringFromName(msgid);
}

// formatStringFromName 
function ArchibaldFormatStringFromName(msgid, vals, nb){
  
  if (null==g_messages_archibald)
    g_messages_archibald=Services.strings.createBundle("chrome://archibald/locale/archibald.properties");

  return g_messages_archibald.formatStringFromName(msgid, vals, nb);
}

/*
* Affichage d'un message à partir de l'identifiant dans archibald.properties
*
* @param msgid identifiant du message
*/
function ArchibaldAfficheMsgId(msgid){
  
  let  msg=ArchibaldMessageFromId(msgid);
   
  Services.prompt.alert(window, ArchibaldMessageFromId("archibaldPromptTitle"), msg);
}

/*
* Affichage d'un message à partir de l'identifiant dans archibald.properties
*
* @param msgid identifiant du message
* @param msg2 message additionnel affiché sur nouvelle ligne (optionnel)
*/
function ArchibaldAfficheMsgId2(msgid,msg2){
  
  let  msg=ArchibaldMessageFromId(msgid);
  if (null!=msg2)
    msg+="\n"+msg2;
  
  Services.prompt.alert(window, ArchibaldMessageFromId("archibaldPromptTitle"), msg);
}



/*
* Génération de traces dans la console
*/
var gArchibaldInitTrace=false;
var gArchibaldConsole=null;

function ArchibaldTrace(msg){
  
  if (!gArchibaldInitTrace){
    let t=Services.prefs.getBoolPref("archibald.trace");
    if (t)
      gArchibaldConsole=Services.console;
    gArchibaldInitTrace=true;
  }
  if (gArchibaldConsole)
    gArchibaldConsole.logStringMessage("[Archibald] "+msg);
}


/*
* fonctions d'enregistrement des evenement (fichier log)
* (reprise fonctions module pacome)
*/
//nom du fichier log
const ARCHIBALD_FICHIER_LOG="archibald.log";
const ARCHIBALD_FICHIER_LOG_SEP="\t";
//source d'evenement
const ARCHIBALD_LOGS_MODULE="ARCHIBALD";
const ARCHIBALD_LOGS_CPBAL="CPBAL";
//taille maxi du fichier de logs avant rotation
const ARCHIBALD_LOGS_MAX=1000000;
const ARCHIBALD_FICHIER_LOG1="archibald-1.log";

var gArchibaldFichierLogs=null;

/* rotation fichier logs
 supprime *-1.log existant
 renomme en *-1.log
 cree *.log
*/
function ArchibaldLogsRotate(){

  try{

    ArchibaldTrace("ArchibaldLogsRotate.");

    let  fichier=ArchibaldGetProfD();
    fichier.append(ARCHIBALD_FICHIER_LOG);
    fichier.moveTo(null, ARCHIBALD_FICHIER_LOG1);

  } catch(ex){
    ArchibaldTrace("ArchibaldLogsRotate exception."+ex);
  }
}


//initialisation
function ArchibaldInitLogs(){

  try{

    let  fichier=ArchibaldGetProfD();
    fichier.append(ARCHIBALD_FICHIER_LOG);

    if (fichier.exists()){
      //v2.6 - test taille fichier
      if (fichier.fileSize>ARCHIBALD_LOGS_MAX){
        ArchibaldLogsRotate();
      }
    } else {
      fichier.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE,0664);
    }

    gArchibaldFichierLogs=Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);
    gArchibaldFichierLogs.init(fichier,0x02|0x08|0x10, 0664,0);

  } catch(ex){
    ArchibaldTrace("ArchibaldInitLogs exception."+ex);
  }
}


//écriture evenement
function ArchibaldEcritLog(source, description, donnees){

  if (null==gArchibaldFichierLogs){
    ArchibaldTrace("ArchibaldEcritLog fichier non initialise");
    return null;
  }

  //date heure
  let  dh=new Date();
  let  strdh="["+dh.getDate()+"/"+(dh.getMonth()+1)+"/"+dh.getFullYear()+" "+dh.getHours()+":"+dh.getMinutes()+":"+dh.getSeconds()+"]";
  let  src="";
  if (null!=source)
    src=source;
  let  desc="";
  if (null!=description)
    desc=description;
  let  don="";
  if (null!=donnees)
    don=donnees;

  let  msg=strdh+ARCHIBALD_FICHIER_LOG_SEP+"["+src+"]"+ARCHIBALD_FICHIER_LOG_SEP+
          "\""+desc+"\""+ARCHIBALD_FICHIER_LOG_SEP+"\""+don+"\"\x0D\x0A";

  gArchibaldFichierLogs.write(msg, msg.length);
  gArchibaldFichierLogs.flush();
}



/*
* retourne une instance nsIFile du repertoire profil
*/
function ArchibaldGetProfD() {

  return Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
}
