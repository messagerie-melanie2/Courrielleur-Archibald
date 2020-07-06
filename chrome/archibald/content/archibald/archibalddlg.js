/* Variables globales */

//instance ArchibaldArchive
var gArchiveur=null;
//liste des comptes a archiver (cas tous les comptes)
//tableau de ArchibaldParamsCompte
var gArchiListeComptes=null;
//index compte en cours de traitement (0 a N, -1 non commence)
var gArchiIndexCompte=-1;



//objet de notification de l'archivage
var gArchiNotifs={

  //nsIMsgCopyServiceListener
  OnStartCopy: function() {
    ArchibaldTrace("gArchiNotifs OnStartCopy");
  },
  
  OnProgress: function(aProgress, aProgressMax) {
  },
  
  SetMessageKey: function(aKey) {
    gArchibaldUI.comptesUI[gArchiIndexCompte].nbarch.value=gArchiveur.totalarch+gArchiveur.nbarch;
  },
  
  GetMessageId: function() {
  },
  
  OnStopCopy: function(aStatus) {
    ArchibaldTrace("gArchiNotifs OnStopCopy");
  },
  
  //interface nsIUrlListener (pour delete mais pas de notifications)
  OnStartRunningUrl: function(url) {
  },
  
  OnStopRunningUrl: function(url, aExitCode) {
  },

  //fonctions notifications des etapes
  OnErreurArchivage: function(errmsg) {

    ArchibaldTrace("gArchiNotifs OnErreurArchivage "+errmsg);

    DlgUpdateEtatUI("archibaldEtatErreur");

    //notification utilisateur
    ArchibaldAfficheMsgId2("archibaldEtatErreur", errmsg);

  },
  
  OnArchivageStart: function(config) {

    ArchibaldTrace("gArchiNotifs OnArchivageStart");

    DlgUpdateEtatUI("archibaldEtatRech");
  },
  
  OnArchivageEnd: function() {

    ArchibaldTrace("gArchiNotifs OnArchivageEnd gArchibaldUI.nbdossiers="+gArchibaldUI.nbdossiers);

    DlgUpdateEtatUI("archibaldEtatFin");
    DlgUpdateStats();

    window.setTimeout(notifUtilFinArchivage, 100);
  },
  
  OnDossierStart: function(dos) {

    ArchibaldTrace("gArchiNotifs OnDossierStart");

    if (0!=gArchiveur.nbdossiers){
      gArchibaldUI.vustep=gArchibaldUI.vurange/gArchiveur.nbdossiers;
    }

    DlgUpdateEtatUI("archibaldEtatDos");
    DlgUpdateStats();
  },
  
  OnDossierEnd: function() {

    ArchibaldTrace("gArchiNotifs OnDossierEnd");

    gArchibaldUI.vuprogress+=gArchibaldUI.vustep;
    gArchibaldUI.vumetre.value=gArchibaldUI.vuprogress;

    DlgUpdateStats();
  },
  
  OnArretForce: function() {
  },
  
  OnArchiveMsg: function(nb){

    DlgUpdateEtatUI("archibaldEtatArch");
    DlgUpdateStats();
  },
  
  OnSupMsg: function(nb){

    DlgUpdateEtatUI("archibaldEtatSup");
  },

  /* Telechargement offline */
  OnSynchroStart: function() {
    DlgUpdateEtatUI("archibaldEtatSynchroStart");
  },
  //fin de la synchronisation
  OnSynchroEnd: function() {
    DlgUpdateEtatUI("archibaldEtatSynchroEnd");
  },
  //demarrage de telechargement d'un dossier nsIMsgFolder
  OnSynchroDossierStart: function(dossier) {

  },
  //fin de telechargement d'un dossier nsIMsgFolder
  OnSynchroDossierEnd: function(dossier) {

  },
  //notification d'erreur
  //message: texte du message d'erreur
  OnSynchroError: function(message) {

  },
  /* Fin telechargement offline */

  /* decouverte des dossiers */
  StartDiscoverFolders: function() {
    DlgUpdateEtatUI("archibaldEtatRech");
  },

  EndDiscoverFolders: function(resultat) {

  }
};



//elements d'interface
var gArchibaldUI={

  //archibalddlg-etat
  etat: null,
  //archibalddlg.vu
  vumetre: null,
  //variables pour vumetre
  // 100/nb compte
  vurange:100,
  // vurange/nb dossier du compte
  vustep:100,
  vuprogress:0,

  //tableau des elements de compte
  comptesUI: null,

  //telechargement des messages
  totaldossiers: 0,
  nbdossiers:0
};

// bdossier : si true indique archivage d'un compte du type dossiers
function InitArchibaldUI(bdossier) {

  gArchibaldUI.etat=document.getElementById("archibalddlg-etat");
  gArchibaldUI.vumetre=document.getElementById("archibalddlg.vu");
  
  if (bdossier){
  
    document.title=ArchibaldMessageFromId("archivageDossiersTitre");
    let  bandeau=document.getElementById("bandeau-titre");
    bandeau.textContent=ArchibaldMessageFromId("archivageDossiersBandeau");
    let  col1=document.getElementById("col1");
    col1.value=ArchibaldMessageFromId("archivageDossiersCol1");
  }

  gArchibaldUI.comptesUI=new Array();
}

//cree elements ui d'un compte
//index : position dans gArchiListeComptes
function ArchiCreeCompteUI(index) {

  ArchibaldTrace("ArchiCreeCompteUI index="+index);

  if (index>=gArchiListeComptes.length) {
    ArchibaldTrace("ArchiCreeCompteUI index hors limite");
    return;
  }

  let  config=gArchiListeComptes[index];

  let  row=document.createElement("row");
  let  bal=document.createElement("label");
  let  nbmsg=document.createElement("label");
  let  nbarch=document.createElement("label");
  let  nbsup=document.createElement("label");

  let  r=document.getElementById("archibalddlg.rows");

  bal.setAttribute("value", config.libelle);
  bal.setAttribute("tooltiptext", config.libelle);
  bal.setAttribute("crop", "end");
  bal.setAttribute("class", "col1");
  row.appendChild(bal);

  nbmsg.setAttribute("value", "-");
  nbmsg.setAttribute("class", "col2");
  row.appendChild(nbmsg);

  nbarch.setAttribute("value", "-");
  nbarch.setAttribute("class", "col2");
  row.appendChild(nbarch);

  nbsup.setAttribute("value", "-");
  nbsup.setAttribute("class", "col2");
  row.appendChild(nbsup);

  r.appendChild(row);

  let  elemui=new Object();
  elemui.bal=bal;
  elemui.nbmsg=nbmsg;
  elemui.nbarch=nbarch;
  elemui.nbsup=nbsup;

  gArchibaldUI.comptesUI.push(elemui);
}

//idetat : archibaldEtatxxx dans archibald.properties
function DlgUpdateEtatUI(idetat) {

  if ("archibaldEtatFin"==idetat){

    DlgUpdateStats();
    if (gArchibaldUI.etat.value!=ArchibaldMessageFromId("archibaldEtatErreur")) {
      gArchibaldUI.etat.value=ArchibaldMessageFromId(idetat);
    }

  } else 	if ("archibaldEtatPret"==idetat ||
      "archibaldEtatRech"==idetat) {
        
    gArchibaldUI.etat.value=ArchibaldMessageFromId(idetat);
    
  } else if ("archibaldEtatDos"==idetat) {
    
    let  dos=gArchiveur.getDossierCourant();
    gArchibaldUI.etat.value=ArchibaldMessageFromId(idetat)+" : "+dos.name;
    
  } else if ("archibaldEtatErreur"==idetat) {
    
    gArchibaldUI.etat.value=ArchibaldMessageFromId(idetat)+" : "+gArchiveur.GetMsgErreur();
    
  } else if ("archibaldEtatArch"==idetat ||
            "archibaldEtatSup"==idetat) {
              
    let  lib=ArchibaldMessageFromId(idetat);
    lib=lib.replace("%nb", gArchiveur.nbmsg);
    gArchibaldUI.etat.value=lib;
    
  } else {
    
    gArchibaldUI.etat.value=ArchibaldMessageFromId(idetat);
    
  }
}

function DlgUpdateStats() {

  gArchibaldUI.comptesUI[gArchiIndexCompte].nbmsg.value=gArchiveur.totalmsg;
  gArchibaldUI.comptesUI[gArchiIndexCompte].nbarch.value=gArchiveur.totalarch;
  gArchibaldUI.comptesUI[gArchiIndexCompte].nbsup.value=gArchiveur.totalsup;
}



/*
* initialisation de la fenêtre
* v5 :
*   une seule boite à la fois => compte est requis dans les arguments d'appel
*   nouveau parametre de dossier optionnel pour archivage d'un dossier
* parametres:
*   config : configuration de la boite a archiver (requis) instance ArchibaldParamsCompte
*   dossier : instance nsIMsgFolder du dossier si archivage de dossier (optionnel)
*/
function initArchibaldDlg(){

  let  config=null;
  let  dossier=null;
  let  sousdossiers=null;

  //compte ou dossier a archiver
  if (window.arguments[0] &&
      window.arguments[0].config){
    config=window.arguments[0].config;
    if (window.arguments[0].dossier) {
      dossier=window.arguments[0].dossier;
      sousdossiers=window.arguments[0].sousdossiers;
    }
  }

  if (null==config) {
    ArchibaldTrace("Appel de la boite d'archivage sans configuration");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Appel de la boite d'archivage sans configuration");
    window.close();
    return;
  }

  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Appel de la boite d'archivage - compte uid:"+config.uid);
  ArchibaldTrace("initArchibalddlg compte="+config.uid);

  let  bdossier=uidIsDossier(config.uid);
  InitArchibaldUI(bdossier);

  //v5 : configuration automatique bali necessaire?
  if (config.isBali() &&
      (!config.etat ||
        !config.isDossierValide())) {
    let  jours=config.jours;
    config=archiAutoConfBali(config.uid);
    if (null==config) {
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Appel de la boite d'archivage - erreur de configuration automatique");
      window.close();
      return;
    }
    config.jours=jours;
  }

  gArchiListeComptes=new Array();

  gArchiListeComptes.push(config);

  gArchiIndexCompte=0;

  ArchiCreeCompteUI(0);

  gArchiveur=new ArchibaldArchive(gArchiNotifs);

  if (null==dossier) {

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Appel de la boite d'archivage - archivage du compte");
    gArchiveur.ArchivageCompte(config);

  } else {

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Appel de la boite d'archivage - archivage d'un dossier");
    gArchiveur.ArchivageDossier(config, dossier, sousdossiers);
  }
}


/*
* v5 : si archivage en cours => stopper
*/
function btArchibaldQuitter(){
  
  ArchibaldTrace("btArchibaldQuitter");
  
  if (null!=gArchiveur) {
    if (gArchiveur.isEncours()){
      //forcer l'arret
      gArchiveur.ArretArchivage();
    }
    gArchiveur.ecouteur=null;
  }

  window.close();
}


/*
* Boite de notification de fin d'archivage à l'utilisateur (popup)
* ferme la boîte d'archivage
*/
function notifUtilFinArchivage() {
  ArchibaldAfficheMsgId("archibaldEtatFin");
  window.close();
}
