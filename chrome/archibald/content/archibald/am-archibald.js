ChromeUtils.import("resource:///modules/mailServices.js");

//instance ArchibaldParamsCompte courante
var gParamsArchiBal=null;


function onPreInit(account, accountvalues) {

  //parent -> contexte accountmanager-overlay
  let  serverkey=account.incomingServer.key;
  ArchibaldTrace("onPreInit serverkey:"+serverkey);
  gParamsArchiBal=parent.archiGetConfig(serverkey);
  
  //liste des dossiers
  initListeDossiers();
}

function onInit(pageId, serverId) {

  ArchibaldTrace("onInit pageId="+pageId+" - serverId="+serverId);

  if ("am-archibald.xul"!=pageId) 
    return;

  //parametres
  let  etat=gParamsArchiBal.etat;
  ArchibaldTrace("onInit gParamsArchiBal.uid:"+gParamsArchiBal.uid);
  ArchibaldTrace("onInit gParamsArchiBal.dossier:"+gParamsArchiBal.dossier);
  if (""!=gParamsArchiBal.dossier)
    getCtrlListe().value=gParamsArchiBal.dossier;
  getCtrlEtat().checked=etat;
  getCtrlJours().value=gParamsArchiBal.jours;

  //date picker
  initdatepicker(gParamsArchiBal.jours);

  gParamsArchiBal.serverId=serverId;

  let  actif=document.getElementById("archibald.actif");

  if (!etat){
    actif.setAttribute("disabled",true);
  }
  else{
    actif.removeAttribute("disabled");
  }

  //libelle granularite
  setLibelleGranularite();
}

/*
* met à jour le libelle de granularite (a droite du bouton)
*/
function setLibelleGranularite() {
  
  let  lib=document.getElementById("archibald.Hierarchy");
  let  msgid="archibaldGranul"+gParamsArchiBal.archiveGranularity;
  if (gParamsArchiBal.archiveKeepFolderStructure)
    msgid+="D";
  ArchibaldTrace("onInit msgid granularite:"+msgid);
  lib.value=ArchibaldMessageFromId(msgid);
}

/*
* initialisation date picker a partir du nombre de jours
*/
function initdatepicker(jours) {

  let  dp=document.getElementById("archidt");
  let  today=new Date();
  let  ms=today.getTime();
  ms-=jours*86400000;
  today.setTime(ms);
  dp.dateValue=today;
}

/* sauvegarde temporaire de la configuration du compte affiche */
function onSave() {

  gParamsArchiBal.etat=getCtrlEtat().checked;
  gParamsArchiBal.dossier=getCtrlListe().value;
  gParamsArchiBal.jours=getCtrlJours().value;

  //parent -> contexte accountmanager-overlay
  parent.archiMemoConfig(gParamsArchiBal);
}


/*
* gère la case à cocher d'archivage des messages
*
*/
function checkArchive(ev){

  let  etat=ev.target.getAttribute("checked");

  let  actif=document.getElementById("archibald.actif");

  if (!etat){

    actif.setAttribute("disabled",true);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage desactive uid:", gParamsArchiBal.uid);

  } else{

    //configuration automatique pour les bali?
    if (gParamsArchiBal.isBali()){

      //dossier non configure => demande configuration automatique
      let  res=askConfigureAuto();

      if (true==res) {

        let  uid=gParamsArchiBal.uid;

        //configuration automatique
        let  config=archiAutoConfBali(uid)
        if (null==config) {
          ev.target.setAttribute("checked", false);
          actif.setAttribute("disabled",true);
          return;
        }
        //memorisation dans le gestionnaire (temporaire)
        parent.archiMemoConfig(config);
        gParamsArchiBal=config;
        //en mode automatique, on sauvegarde avec la granularite
        ArchibaldSauveParamsCompte(config, true);

        //reinitialise la liste
        initListeDossiers();

        //preselectionner le nouveau dossier
        getCtrlListe().value=uid;
      }
    }

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Activation archivage active uid:", gParamsArchiBal.uid);
    actif.removeAttribute("disabled");
  }
}

/*
* retourne le controle case a cocher
*
* @return: element xul
*
*/
function getCtrlEtat(){
  
  return document.getElementById("archibald.etat");
}

/*
* retourne le controle de la liste des comptes
*
* @return: element xul
*
*/
function getCtrlListe(){
  
  return document.getElementById("archibald.dossiers");
}


/*
* retourne le contrôle de l'age en jours
*
* @return: element xul
*
*/
function getCtrlJours(){
  
  return document.getElementById("archibald.agejours");
}


/*
* Rôle : controle la saisie des jours
*
*/
function saisieJours(){

  let  jours=getCtrlJours();
  jours.value=jours.value.match(/[0-9]+/g);
  //mettre a jour date picker
  initdatepicker(jours.value);
}



/**
* initialise la liste des dossiers locaux
* v5 : les dossiers utilises pour d'autres configurations ne sont pas affichees
* v6 : ne pas affiche le meme dossier
* @return: true si ok, false si erreur
*
*/
function initListeDossiers(){

  let  liste=getCtrlListe();
  liste.removeAllItems();

  let  dossiers=ListeDossiers();
  let  serverkey=gParamsArchiBal.serverkey;
  
  for (var  i=0;i<dossiers.length;i++){
    ArchibaldTrace("initListeDossiers lib:"+dossiers[i]["lib"]+" - id:"+dossiers[i]["id"]);
    if (dossiers[i]["key"]==serverkey ||
        (dossiers[i]["bal"] && 
        dossiers[i]["bal"]!=serverkey)) {
      ArchibaldTrace("initListeDossiers dossier ignore server:"+dossiers[i]["bal"]);
      continue;
    }
    liste.appendItem(dossiers[i]["lib"], dossiers[i]["id"]);
  }

  return true;
}

/*
*	retourne la liste des dossiers locaux triee
*
*	@return Array tableau des dossiers - index : id (hostName) et lib (prettyName)
* v5 : indication de l'usage des dossiers locaux
* si mail.server.serverX.archibald.dossier= id
* => index bal=serverX
*
*/
function ListeDossiers(){

  let  serveurs=MailServices.accounts.allServers;
  let  dossiers=new Array();
  let  boites=new Array();
  let  nb=0;
  for (var  i=0;i<serveurs.length;i++){
    let  srv=serveurs.queryElementAt(i, Components.interfaces.nsIMsgIncomingServer);
    if (srv.type=="none"){
      dossiers[nb]=Array();
      dossiers[nb]["id"]=srv.hostName;
      dossiers[nb]["lib"]=srv.prettyName;
      dossiers[nb]["key"]=srv.key;
      nb++;
    } else if ("pop3"==srv.type || "imap"==srv.type) {
      //boite avec dossier?
      let  srvkey=srv.key
      let  prefname="mail.server."+srvkey+".archibald.dossier";
      if (Services.prefs.prefHasUserValue(prefname)){
        let  dossier=Services.prefs.getCharPref(prefname);
        ArchibaldTrace("ListeDossiers dossier:"+dossier+" => boite:"+srvkey);
        boites[dossier]=srvkey;
      }
    }
  }

  for (var  i=0;i<nb;i++) {
    let  dossier=dossiers[i]["id"];
    if (boites[dossier]) {
      dossiers[i]["bal"]=boites[dossier];
    }
  }

  function tridossiers(a, b) {
    return a["lib"] > b["lib"];
  }

  return dossiers.sort(tridossiers);
}


/**
* appel boîte de modification des options des dossiers
*/
function ArchiOptionsDossiers(){

  if (null==gParamsArchiBal || null==gParamsArchiBal.serverId)
    return;

  let  args=new Object();
  args.params=gParamsArchiBal;

  ArchibaldTrace("ArchiOptionsDossiers appel boite options serverId="+args.params.serverId);

  window.openDialog("chrome://archibald/content/optiondossiers.xul","","chrome,center,titlebar,resizable",args);
}

/*
* Création d'un nouveau dossier local pour le compte en cours de configuration
* utilise les services de pacome
*/
function ArchiNouveauDossier() {

  //affichage boite de creation de dossier local pacome
  let  args=new Object();
  let  res=window.openDialog("chrome://pacome/content/dossierlocal.xul","","chrome,modal,centerscreen,titlebar", args);

  ArchibaldTrace("ArchiNouveauDossier res="+res);

  if (1!=args.res) {
    ArchibaldTrace("ArchiNouveauDossier 1!=args.res");
  }

  ArchibaldTrace("ArchiNouveauDossier args.nom="+args.nom);

  //reinitialise la liste
  initListeDossiers();

  //preselectionner le nouveau dossier
  getCtrlListe().value=args.hostname;

  return;
}


/*
* Propose a l'utilisateur de creer le dossier automatiquement
* return true si oui, false si non
*/
function askConfigureAuto() {

  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Demande utilisateur configuration automatique");

  //afficher demande de creation automatique
  let promptService=Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);
  let checkValue={value: false};

  let res=promptService.confirmEx(window, ArchibaldMessageFromId("archibaldConfigAutoTitre"),
                                  ArchibaldMessageFromId("archibaldConfigureAuto"),
                                  promptService.STD_YES_NO_BUTTONS,
                                  "","","","",checkValue);
  if (0!=res) {
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "refus utilisateur configuration automatique");
    return false;
  }
  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "utilisateur demande configuration automatique");
  return true;
}


/**
* bouton Options d'archivage
* modification du classement des archives annee/mois/dossiers
* par defaut: annee+dossiers
*/
function archiChangeHierarchy() {

  //valeurs par defaut?
  //archiveGranularity
  //archiveKeepFolderStructure
  let  ident={};
  ident.archiveGranularity=gParamsArchiBal.archiveGranularity;
  ident.archiveKeepFolderStructure=gParamsArchiBal.archiveKeepFolderStructure;
  
  top.window.openDialog("chrome://messenger/content/am-archiveoptions.xul",
                        "", "centerscreen,chrome,modal,titlebar,resizable=yes",
                        ident);
                        

  if (ident.archiveGranularity!=gParamsArchiBal.archiveGranularity ||
      ident.archiveKeepFolderStructure!=gParamsArchiBal.archiveKeepFolderStructure){
    //sauvegarder les valeurs (comportement boite tb);
    ArchibaldTrace("archiChangeHierarchy sauvegarde la granularite");
    gParamsArchiBal.archiveGranularity=ident.archiveGranularity;
    gParamsArchiBal.archiveKeepFolderStructure=ident.archiveKeepFolderStructure;
    
    ArchibaldSauveGranul(gParamsArchiBal);
    
    setLibelleGranularite();
  }
  return true;
}


/*
* datepicker::onchange
*/
function archiChgDate(picker) {

  let  dt=picker.dateValue;
  ArchibaldTrace("archiChgDate valeur date:"+dt);
  let  today=new Date();
  if (dt>today) {
    dt=today;
    picker.dateValue=today;
  }
  let  newjours=(today.getTime()-dt.getTime())/86400000;
  ArchibaldTrace("archiChgDate newjours:"+newjours);
  let  jours=getCtrlJours();
  jours.value=Math.round(newjours);
}
