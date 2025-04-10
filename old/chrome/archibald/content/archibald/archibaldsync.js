
//modes de fonctionnement
const ARCHSYNC_NONE=0;
//telechargement de dossiers
const ARCHSYNC_DOS=1;
//telechargement de messages
const ARCHSYNC_MSG=2;


function ArchibaldSync(ecouteur){
  ArchibaldTrace("ArchibaldSync");
  if (null!=ecouteur)
    this.ecouteur=ecouteur;
}

ArchibaldSync.prototype={

  //tableau des dossiers (nsIMsgFolder) a traiter
  listedossiers: null,
  //index du dossier en cours
  index_dossier: -1,

  //ecouteur externe pour les notifications
  ecouteur: null,

  msgWindow: null,

  modeencours: ARCHSYNC_NONE,

  /* fonctions principales */

  //Telechargement offline des dossiers
  //dossiers: tableau de dossiers nsIMsgFolder
  //fonctionnement asynchrone
  SynchroniseDossiers: function(dossiers) {

    ArchibaldTrace("SynchroniseDossiers");

    if (null==dossiers ||
        0==dossiers.length) {
      ArchibaldTrace("SynchroniseDossiers - Aucun dossier a telecharger!");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun dossier a telecharger!");
      this.OnSynchroEnd();
      return;
    }

    this.listedossiers=dossiers;
    this.index_dossier=0;

    this.modeencours=ARCHSYNC_DOS;

    this.msgWindow=Components.classes["@mozilla.org/messenger/msgwindow;1"]
                              .createInstance(Components.interfaces.nsIMsgWindow);

    this.OnSynchroStart();

    this.telechargeDossierCourant();
  },

  //Telechargement d'une liste de messages
  //les messages ne sont pas forcement dans le meme dossier
  //listemsg: tableau de nsIMsgDBHdr
  SynchroniseMessages: function(listemsg) {

    ArchibaldTrace("SynchroniseMessages");

    if (null==listemsg) {
      ArchibaldTrace("SynchroniseMessages - Aucun message a telecharger!");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun message a telecharger!");
      this.OnSynchroEnd();
      return;
    }

    const nb=listemsg.length;
    if (0==nb) {
      ArchibaldTrace("SynchroniseMessages - Aucun message a telecharger!");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun message a telecharger!");
      this.OnSynchroEnd();
      return;
    }

    //liste des dossiers
    this.listedossiers=new Array();
    this.index_dossier=0;//non utilise
    let  nbdos=0;
    for (var  m=0;m<nb;m++) {
      let  dos=listemsg[m];
      let  dosuri=dos.folder.URI;
      if (null==this.listedossiers[dosuri]) {
        ArchibaldTrace("SynchroniseMessages - listedossiers[dosuri]:"+dosuri);
        this.listedossiers[dosuri]=new Array();
        nbdos++;
      }
      this.listedossiers[dosuri].push(listemsg[m]);
    }
    ArchibaldTrace("SynchroniseMessages - nombre de dossiers:"+nbdos);

    this.modeencours=ARCHSYNC_MSG;

    this.msgWindow=Components.classes["@mozilla.org/messenger/msgwindow;1"]
                              .createInstance(Components.interfaces.nsIMsgWindow);
    this.msgWindow.statusFeedback=this;

    this.OnSynchroStart();

    this.telechargeDosMsgSuivant();
  },

  //Telechargement des messages d'un dossier
  //dossier : instance nsIMsgFolder
  //listemsg: tableau de nsIMsgDBHdr
  SynchroniseDossierMsg: function(dossier, listemsg){

    ArchibaldTrace("SynchroniseDossierMsg");

    if (null==listemsg) {
      ArchibaldTrace("SynchroniseDossierMsg - Aucun message a telecharger!");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun message a telecharger!");
      this.OnSynchroEnd();
      return;
    }

    const nb=listemsg.length;
    if (0==nb) {
      ArchibaldTrace("SynchroniseDossierMsg - Aucun message a telecharger!");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun message a telecharger!");
      this.OnSynchroEnd();
      return;
    }

    let  dosuri=dossier.URI;
    this.listedossiers=new Array();
    this.index_dossier=0;//non utilise
    this.listedossiers[dosuri]=listemsg;
    this.modeencours=ARCHSYNC_MSG;

    this.msgWindow=Components.classes["@mozilla.org/messenger/msgwindow;1"]
                              .createInstance(Components.interfaces.nsIMsgWindow);
    this.msgWindow.statusFeedback=this;

    this.OnSynchroStart();

    this.telechargeDosMsgSuivant();
  },

  /* notifications ecouteur */

  //implementer les memes fonctions dans l'ecouteur externe (appelant)
  //demarrage de la synchronisation
  OnSynchroStart: function() {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroStart)
      this.ecouteur.OnSynchroStart();
  },
  
  //fin de la synchronisation
  OnSynchroEnd: function() {
    this.modeencours=ARCHSYNC_NONE;
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroEnd)
      this.ecouteur.OnSynchroEnd();
    this.msgWindow=null;
  },
  
  //demarrage de telechargement d'un dossier nsIMsgFolder
  OnSynchroDossierStart: function(dossier) {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroDossierStart)
      this.ecouteur.OnSynchroDossierStart(dossier);
  },
  
  //fin de telechargement d'un dossier nsIMsgFolder
  OnSynchroDossierEnd: function(dossier) {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroDossierEnd)
      this.ecouteur.OnSynchroDossierEnd(dossier);
  },
  //notification d'erreur
  //message: texte du message d'erreur
  OnSynchroError: function(message) {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroError)
      this.ecouteur.OnSynchroError(message);
    this.msgWindow=null;
  },


  /* fonction internes */
  telechargeDossierCourant: function() {
    
    ArchibaldTrace("ArchibaldSync telechargeDossierCourant");
    let  dos=this.getDossierCourant();
    if (null==dos) {
      ArchibaldTrace("ArchibaldSync telechargement des dossiers termine");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des dossiers termine");
      this.OnSynchroEnd();
      return;
    }

    ArchibaldTrace("ArchibaldSync telechargeDossierCourant dossier:"+dos.URI);
    ArchibaldTrace("ArchibaldSync telechargeDossierCourant dos.supportsOffline:"+(dos.supportsOffline?"true":"false"));

    while (!dos.supportsOffline) {
      ArchibaldTrace("ArchibaldSync pas de support offline pour le dossier:"+dos.name);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Pas de support offline pour le dossier", dos.name);

      dos=this.getDossierSuivant();

      if (null==dos) {
        ArchibaldTrace("ArchibaldSync telechargeDossierCourant telechargement des dossiers termine");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des dossiers termine");
        this.OnSynchroEnd();
        return;
      }
    }

    ArchibaldTrace("ArchibaldSync telechargement du dossier:"+dos.URI);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement du dossier:", dos.name);
    this.OnSynchroDossierStart(dos);
    dos.downloadAllForOffline(this, this.msgWindow);
  },
  
  //retourne le dossier suivant dans listedossiers
  //ou null si aucun
  getDossierSuivant: function() {

    if (this.index_dossier+1 == this.listedossiers.length) {
      return null;
    }
    this.index_dossier++;
    if (0>this.index_dossier) {
      return null;
    }
    return this.listedossiers[this.index_dossier];
  },

  getDossierCourant: function() {
    if (0>this.index_dossier ||
        this.index_dossier == this.listedossiers.length) {
      return null;
    }
    return this.listedossiers[this.index_dossier];
  },

  //Telechargement des messages d'un dossier
  telechargeDosMsgSuivant: function() {

    ArchibaldTrace("telechargeDosMsgSuivant");

    if (null==this.listedossiers) {
      ArchibaldTrace("ArchibaldSync telechargeDosMsgSuivant telechargement des messages termine");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des messages termine");
      this.OnSynchroEnd();
      return;
    }

    for (var  dosuri in this.listedossiers) {
      ArchibaldTrace("ArchibaldSync telechargeDosMsgSuivant dosuri:"+dosuri);
      let  dosmsg=this.listedossiers[dosuri];
      let  dossier=this.listedossiers[dosuri][0].folder;

      let  msgs=Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
      const nb=dosmsg.length;
      for (var  m=0;m<nb;m++) {
        let  hdr=dosmsg[m];
        if (hdr.flags & Components.interfaces.nsMsgMessageFlags.Offline)
          continue;
        msgs.appendElement(hdr, false);
      }

      delete this.listedossiers[dosuri];

      if (0==msgs.length) {
        ArchibaldTrace("ArchibaldSync telechargeDosMsgSuivant tous les messages sont offline");
        msgs=null;
        continue;
      }

      ArchibaldTrace("ArchibaldSync telechargeDosMsgSuivant DownloadMessagesForOffline");
      dossier.DownloadMessagesForOffline(msgs, this.msgWindow);
      return;
    }

    ArchibaldTrace("ArchibaldSync telechargeDosMsgSuivant telechargement des messages termine");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des messages termine");
    this.OnSynchroEnd();
    return;
  },

  /* notifications recues - usage interne */
  OnStartRunningUrl: function(url) {
    ArchibaldTrace("ArchibaldSync OnStartRunningUrl url.spec:"+url.asciiSpec);
    if (null!=this.ecouteur)
      this.ecouteur.OnStartRunningUrl(url);
  },
  
  OnStopRunningUrl: function(url, aExitCode) {
    ArchibaldTrace("ArchibaldSync OnStopRunningUrl url.spec:"+url.asciiSpec);
    let dos=this.getDossierCourant();
    this.OnSynchroDossierEnd(dos);
    if (0==aExitCode) {
      //suivant
      dos=this.getDossierSuivant();
      if (null==dos) {
        this.OnSynchroEnd();
      } else
        this.telechargeDossierCourant();
    } else {
      this.OnSynchroError("Echec de telechargement du dossier '"+dos.name+"' - code erreur:"+aExitCode);
      this.OnSynchroEnd();
    }
  },

  showStatusString: function(aStatus) {
    ArchibaldTrace("ArchibaldSync showStatusString:"+aStatus);
  },
  
  startMeteors: function() {
    ArchibaldTrace("ArchibaldSync startMeteors");
  },
  
  stopMeteors: function() {
    ArchibaldTrace("ArchibaldSync stopMeteors");
    if (ARCHSYNC_MSG==this.modeencours){
      this.telechargeDosMsgSuivant();
    }
  },
  
  showProgress: function(aPercent) {},
  
  setStatusString: function(aStatus) {
    ArchibaldTrace("ArchibaldSync setStatusString:"+aStatus);
  }
}
