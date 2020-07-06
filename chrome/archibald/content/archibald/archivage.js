ChromeUtils.import("resource:///modules/MailUtils.js");
ChromeUtils.import("resource:///modules/mailServices.js");

/*
* objet d'archivage
*
* fonctions principales:
*   ArchivageCompte(config) : configuration d'archivage du compte (instance ArchibaldParamsCompte)
*   ArchivageDossier(config, dossier) : archivage d'un dossier (instance nsIMsgFolder)
*   ArchivageMessages(config, aMsgHdrs): archivage d'une liste de messages (array de nsIMsgDBHdr)
* config:instance ArchibaldParamsCompte
*
* ecouteur : implemente nsIMsgCopyServiceListener + fonctions de notifications:
* OnArchivageStart(config) demarre l'archivage d'un compte (config : ArchibaldParamsCompte)
* OnArchivageEnd()
* OnDossierStart(dos) demarre l'archivage d'un dossier (dos: instance nsIMsgFolder)
* OnDossierEnd()
* OnErreurArchivage(errmsg) erreur generale -> arret. errmsg: message d'erreur
* OnArretForce() notification prise en compte arret force
* OnArchiveMsg(nb) nb nombre de messages qui vont etre archives
* OnSupMsg(nb) nb nombre de messages qui vont etre supprimes
*/


//types d'archivages
const ARCH_TYPE_NONE=0;
const ARCH_TYPE_COMPTE=1;
const ARCH_TYPE_DOSSIER=2;
const ARCH_TYPE_MSG=4;


function ArchibaldArchive(ecouteur){

  this.ecouteur=ecouteur;
  this.msgerreur="";
  this.typearchivage=ARCH_TYPE_NONE;

  //win32
  let  plt=navigator.platform;
  this.win32=false;
  if (-1!=plt.search(/Win32/gi)){
    ArchibaldTrace("ArchibaldArchive win32");
    this.win32=true;
  }
  
  ArchibaldInitLogs();
}

ArchibaldArchive.prototype={

  //configuration d'archivage du compte
  config: null,
  //instance ArchibaldDossiers
  optionsdossiers: null,

  //config.jours -> date d'archivage (compatible header.date)
  datehdr: 0,

  //dossier source racine du compte a archiver
  dossiersrc_racine: null,
  //liste des dossiers a traiter du compte
  listedossiers: null,
  //index dossier en cours dans listedossiers
  index_dossier: 0,
  //si true, telechargement offline des dossiers/messages
  downloadforoffline: true,

  //dossier archive racine
  dossierdest_racine: null,
  //dossier archive courant
  dossierdest_courant: null,
  //si true, marque les messages archives a lus
  msg_markread: true,

  //groupes de messages d'un dossier a traiter
  //msg_groups["dossier"]: instance du dossier
  //msg_groups["groupes"]: messages a traiter du dossier classer selon granularite
  //config.archiveGranularity=0, 1 seul indice 0
  //config.archiveGranularity=1 indices 'aaaa' (annee)
  //config.archiveGranularity=2 indices 'aaaa-mm' (annee-mois)
  msg_groups: null,

  //messages classes par dossiers
  //utilise par fonction principale ArchivageMessages
  msgs_dos: null,
  //uri de dossier en cours de traitement
  uricourant: null,

  //dossier et messages en cours de traitement d'archivage
  //memorisation pour la phase telechargement
  dossier_encours: null,
  listemsg_encours: null,

  //forcer l'arret de l'archivage
  arretarchivage: false,
  //indicateur archivage en cours
  encours: false,

  //composant de synchronisation des messages (offline)
  syncrodossiers: null,

  //composant de verouillage archibaldLock
  verrou: null,

  //message d'erreur
  msgerreur: "",

  /* statistiques */
  //nombre de dossier a traiter
  nbdossiers: 0,
  //nombre de messages a traiter dans le dossier en cours
  nbmsg: 0,
  //nombre de messages archives dans le dossier en cours
  nbarch: 0,
  //nombre de messages supprimes dans le dossier en cours
  nbsup: 0,
  //nombre total de messages
  totalmsg: 0,
  //nombre total de messages archives
  totalarch: 0,
  //nombre total de messages supprimes
  totalsup: 0,
  //pour eviter doublons dans SetMessageKey
  lastkey: -1,
  //nombre de messages initial du dossier de destination avant archivage du dossier
  dossierdest_nbinit: 0,

  //instance ArchiDiscoverFolders pour la decouverte des dossiers imap
  foldersDiscoverer: null,
  //option pour ArchivageDossier : si true traite les sous-dossiers
  bSousDossiers: false,

  /* fonctions principales - appels externes */

  //archive un compte archibald
  //config: configuration d'archivage du compte
  ArchivageCompte: function(config) {

    ArchibaldTrace("ArchibaldArchive ArchivageCompte uid="+config.uid);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage d'un compte", "uid="+config.uid);

    try {

      let  res=this.InitArchivage(ARCH_TYPE_COMPTE, config);
      if (0!=res) {
        this.OnErreurArchivage(this.msgerreur);
        return res;
      }

      //chargement options des dossiers
      let archiveur=this;

      function rappelOptionsCompte() {

        ArchibaldTrace("ArchibaldArchive ArchivageCompte chargeOptionsRappel");

        archiveur.msgerreur=archiveur.optionsdossiers.GetMsgErreur();

        if (""!=archiveur.msgerreur) {
          ArchibaldTrace("ArchibaldArchive chargeOptionsRappel erreur:"+archiveur.msgerreur);
          archiveur.OnErreurArchivage(archiveur.msgerreur);
          return;
        }

        //setup dossiers du compte
        archiveur.optionsdossiers.SetupDossiersCompte(archiveur.config.serverkey);

        //etape suivante -> decouverte des dossiers
        ArchibaldTrace("ArchivageCompte etape suivante -> decouverte des dossiers");
        archiveur.dossiersrc_racine=archiveur.getDossierRacineCompte();
        archiveur.discoverAllFolders(archiveur.dossiersrc_racine);

        return;
      }

      ArchibaldTrace("ArchivageCompte Chargement des options des dossiers");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Chargement des options des dossiers", "");

      this.optionsdossiers.ChargeFichierOptions(rappelOptionsCompte);

    } catch(ex) {
      this.OnErreurArchivage("Erreur imprevue dans l'archivage. Exception capturee:"+ex);
    }
  },

  //Archivage d'un dossier
  //ne prend pas en compte l'option du dossier
  //ne traite pas les dossiers virtuels
  //config: configuration d'archivage du compte
  //dossier: instance nsIMsgFolder du dossier a archiver
  //bSousDossiers : si true archive aussi les sous-dossiers
  ArchivageDossier: function(config, dossier, bSousDossiers) {

    if (dossier.getFlag(FLAGS_DOSSIERS.Virtual)) {
      this.msgerreur="Pas de support d'archivage des dossiers virtuels";
      this.OnErreurArchivage(this.msgerreur);
      return;
    }

    try {

      let  res=this.InitArchivage(ARCH_TYPE_DOSSIER, config);
      if (0!=res) {
        this.OnErreurArchivage(this.msgerreur);
        return res;
      }

      ArchibaldTrace("ArchibaldArchive archivage du dossier '"+dossier.name+"' - uid="+this.config.uid);
      ArchibaldTrace("ArchibaldArchive archivage du dossier URI:"+dossier.URI);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage du dossier '"+dossier.name+"' pour le compte", this.config.uid);

      this.bSousDossiers=bSousDossiers;
      ArchibaldTrace("ArchibaldArchive archivage des sous-dossier:"+(bSousDossiers?"true":"false"));
      if (bSousDossiers)
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Option d'archivage des sous-dossiers active");

      //dossiers source
      this.dossiersrc_racine=dossier.server.rootMsgFolder;
      ArchibaldTrace("ArchivageDossier dossiersrc_racine:"+this.dossiersrc_racine.URI);

      //etape suivante -> demarrage archivage
      this.OnArchivageStart(this.config);

      //this.config.modecopie
      if (this.config.modecopie) {
        ArchibaldTrace("Archivage du compte en mode copie des messages");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage du compte en mode copie des messages", "");
      }

      this.listedossiers=[];
      this.listedossiers.push(dossier);
      this.index_dossier=0;

      this.nbdossiers=1;

      if (this.bSousDossiers) {
        //decouverte des dossiers
        ArchibaldTrace("ArchivageDossier decouverte des dossiers");
        this.discoverAllFolders(dossier);

      } else if (this.downloadforoffline) {
        //telechargement des dossiers
        ArchibaldTrace("ArchivageDossier telechargement des dossiers");
        this.telechargeDossiers();

      } else {
        //archivage
        ArchibaldTrace("ArchivageDossier archivage");
        this.archiveDossierCourant();
      }

    } catch(ex) {
      this.OnErreurArchivage("Erreur imprevue dans l'archivage. Exception capturee:"+ex);
    }
  },

  //Archivage d'une selection de messages
  //aMsgHdrs: array de nsIMsgDBHdr
  //v5 ne prend pas en compte d'option du dossier
  // => pas de chargement des options des dossiers dans ce cas
  //config: configuration d'archivage du compte
  //les messages ne sont pas forcement dans le meme dossier source (cas dossier virtuel)
  ArchivageMessages: function(config, aMsgHdrs) {

    try {

      let  res=this.InitArchivage(ARCH_TYPE_MSG, config);
      if (0!=res) {
        this.OnErreurArchivage(this.msgerreur);
        return res;
      }

      this.OnArchivageStart(this.config);

      this.dossiersrc_racine=this.getDossierRacineCompte();

      //classer les messages par dossiers
      this.msgs_dos=this.triMsgsDossiers(aMsgHdrs);

      //archiver la premiere serie de messages
      this.archiveMessagesDos();

      } catch(ex) {
      this.OnErreurArchivage("Erreur imprevue dans l'archivage. Exception capturee:"+ex);
    }
  },

  //forcer l'arret de l'archivage
  ArretArchivage: function(){

    ArchibaldTrace("ArchibaldArchive ArretArchivage");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Commande d'arret d'archivage recue", "");

    this.arretarchivage=true;
  },

  //lecture message d'erreur
  GetMsgErreur: function() {

    return this.msgerreur;
  },

  isEncours: function() {
    return this.encours;
  },

  //retourne un objet avec les statistiques
  GetStats: function() {

    let  stats=new Object();

    stats.nbdossiers=this.nbdossiers;
    stats.nbmsg=this.nbmsg;
    stats.nbarch=this.nbarch;
    stats.totalmsg=this.totalmsg;
    stats.totalarch=this.totalarch;
    stats.nbsup=this.nbsup;
    stats.totalsup=this.totalsup;
  },


  /* fonctions internes */
  //InitArchivage - initialisations
  //arch_type:types d'archivages
  //config: instance de configuration
  //retour: 0 si ok, -1 si erreur
  InitArchivage: function(arch_type, config) {

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Initialisation de l'archivage", "");

    this.initVariables();
    this.initStats();

    if (null==config ||
        null==config.uid ||
        ""==config.uid){
      this.msgerreur=ArchibaldMessageFromId("archibaldErrConfig");
      return -1;
    }

    this.config=config;

    if (!this.config.etat ||
        !this.config.isDossierValide()) {
      this.msgerreur=ArchibaldMessageFromId("archibaldErrConfig");
      return -1;
    }

    if (!ArchibaldIsOnline()){
      this.msgerreur=ArchibaldMessageFromId("archibaldOffline");
      return -1;
    }

    //calcul date archivage des messages
    if (!this.caculDateArchivage()) {
      this.msgerreur=ArchibaldMessageFromId("archibaldErrConfJours");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, this.msgerreur, this.config.jours);
      this.OnErreurArchivage(this.msgerreur);
      return -1;
    }
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage des messages avant le:", new Date(this.datehdr/1000));

    //dossier racine archive
    this.dossierdest_racine=this.getDossierRacineArchive();
    if (null==this.dossierdest_racine) {
      this.msgerreur="Erreur dans l'initialisation du dossier racine d'archivage";
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, this.msgerreur);
      this.OnErreurArchivage(this.msgerreur);
      return -1;
    }
    ArchibaldTrace("Dossier racine d'archivage du compte:"+this.dossierdest_racine.URI);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Dossier racine d'archivage du compte", this.dossierdest_racine.URI);

    //msg_markread
    try {
      let  lu=Services.prefs.getBoolPref("archibald.marquelu");
      this.msg_markread=lu;
      if (this.msg_markread) {
        ArchibaldTrace("Option marquage a lu active");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Option marquage a lu active", "");
      }
      else {
        ArchibaldTrace("Option marquage a lu inactive");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Option marquage a lu inactive", "");
      }
    } catch(ex){
      ArchibaldTrace("Option marquage exception"+ex);
    }

    //loguer la granularite
    let  txt="";
    if (1==config.archiveGranularity)
      txt="annee";
    else if (2==config.archiveGranularity)
      txt="annee/mois";
    if (config.archiveKeepFolderStructure)
      txt+="/dossier";
    ArchibaldTrace("Granularite d'archivage :"+txt);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Granularite d'archivage", txt);

    //downloadforoffline
    try{
      //pas pour les dossiers archivés
      if (uidIsDossier(config.uid))
        this.downloadforoffline=false;
      else
        this.downloadforoffline=Services.prefs.getBoolPref("archibald.downloadforoffline");
    }catch(ex){}

    this.optionsdossiers=new ArchibaldDossiers();

    this.typearchivage=arch_type;

    //cas boîte partagée -> verrouiller l'archivage
    if (uidIsBalp(config.uid)){
      let  res=this.verrouArchivage();
      if (!res) {
        this.OnErreurArchivage("Erreur de verouillage de l'archivage");
        return;
      }
    }

    return 0;
  },

  //lancement operations d'archivage de compte
  execArchivageCompte: function() {

    ArchibaldTrace("execArchivageCompte datehdr="+new Date(this.datehdr/1000));
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Demarrage de l'archivage du compte", "");

    this.OnArchivageStart(this.config);

    //parcours des dossiers du compte
    if (null==this.dossiersrc_racine) {
      this.msgerreur=ArchibaldMessageFromId("archibaldDossierUserErr");
      this.OnErreurArchivage(this.msgerreur);
    }
    ArchibaldTrace("execArchivageCompte racine du compte:"+this.dossiersrc_racine.URI);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Dossier racine du compte", this.dossiersrc_racine.URI);

    //this.config.modecopie
    if (this.config.modecopie) {
      ArchibaldTrace("Archivage du compte en mode copie des messages");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage du compte en mode copie des messages", "");
    }

    this.listedossiers=[];
    this.index_dossier=0;

    //cas courrier entrant boite partagee
    if (this.config.isBalp()) {

      let  option=this.optionsdossiers.LitOptionDossierVal(this.dossiersrc_racine.URI);

      if (ARCH_OPTION_ARCHIVER==option ||
          ARCH_OPTION_SUPPRIMER==option){
        ArchibaldTrace("setupListeDossiers ajout dossier:"+this.dossiersrc_racine.URI);
        this.listedossiers.push(this.dossiersrc_racine);
      }
    }
    ArchibaldTrace("Initialisation de la liste des dossiers");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Initialisation de la liste des dossiers", "");
    this.setupListeDossiers(this.dossiersrc_racine);

    this.nbdossiers=this.listedossiers.length;

    if (0==this.nbdossiers) {
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun dossier a archiver", "");
      ArchibaldTrace("Aucun dossier a archiver");
      this.OnArchivageEnd();
      return;
    }

    if (this.downloadforoffline) {
      //telechargement des dossiers
      this.telechargeDossiers();

    } else {
      //archivage
      this.archiveDossierCourant();
    }
  },

  //construit la liste des dossiers a archiver (ARCH_OPTION_ARCHIVER ou ARCH_OPTION_SUPPRIMER)
  //v5 - ne pas prendre en compte les dossiers virtuels
  setupListeDossiers: function(dos) {
    
    //sous-dossiers
    if (dos.hasSubFolders){

      let  subFolders=dos.subFolders;

      while (subFolders.hasMoreElements()) {

        let  suivant=subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);
        if (null==suivant) {
          ArchibaldTrace("!setupListeDossiers null==suivant");
          continue;
        }
        //dossier virtuel?
        if (suivant.getFlag(FLAGS_DOSSIERS.Virtual)){
          ArchibaldTrace("setupListeDossiers dossier virtuel ignore:"+suivant.name);
          continue;
        }

        let  option=this.optionsdossiers.LitOptionDossierVal(suivant.URI);

        if (ARCH_OPTION_ARCHIVER==option ||
            ARCH_OPTION_SUPPRIMER==option){
          ArchibaldTrace("setupListeDossiers ajout dossier:"+suivant.URI);
          this.listedossiers.push(suivant);
        }

        this.setupListeDossiers(suivant);
      }
    }
  },

  //archivage du dossier courant
  archiveDossierCourant: function(){

    let  dos=this.getDossierCourant();

    ArchibaldTrace("archiveDossierCourant dossier:"+dos.URI);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Traitement du dossier", dos.URI);

    let  listemsg=[];

    this.OnDossierStart(dos);

    let  enumerator=dos.messages;

    while (enumerator.hasMoreElements()){
      let  header=enumerator.getNext();
      if (header instanceof Components.interfaces.nsIMsgDBHdr){
        let  messageDate=header.date;
        if (messageDate<this.datehdr) {
          listemsg.push(header);
        }
      }
    }

    //archivage des messages
    if (0==listemsg.length){
      ArchibaldTrace("archiveDossierCourant aucun message a archiver dans le dossier");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun message a archiver dans le dossier", dos.name);
      this.OnDossierEnd();
      return;
    }

    let  option=this.optionsdossiers.LitOptionDossierVal(dos.URI);
    //ne sera pas execute si le chargement des options n'est pas realise
    //cas ArchivageDossier, ArchivageMessages
    if (ARCH_OPTION_SUPPRIMER==option){
      ArchibaldTrace("archiveDossierMessages ARCH_OPTION_SUPPRIMER");
      this.supprimeListeMessages(dos, listemsg);
      return;
    }

    if (uidIsBalp(this.config.uid)){
      let  res=this.majVerrouArchivage();
      if (false==res) {
        ArchibaldTrace("archiveDossierCourant erreur de mise a jour verrou");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur de mise a jour du verrou", "");
        this.msgerreur="Erreur de mise a jour du verrou";
        this.OnErreurArchivage(this.msgerreur);
        return;
      }
    }

    //archivage des messages d'un dossier
    this.archiveDossierMessages(dos, listemsg);
  },

  //retourne le dossier en cours de traitement dans this.listedossiers
  getDossierCourant: function() {

    if (0>this.index_dossier ||
        this.index_dossier+1 > this.listedossiers.length) {
      ArchibaldTrace("Erreur getDossierCourant index_dossier="+this.index_dossier+" - nombre dossiers:"+this.listedossiers.length);
      return null;
    }

    return this.listedossiers[this.index_dossier];
  },

  //retourne le dossier suivant a traiter
  //instance
  getDossierSuivant: function() {
    if (this.index_dossier+1 == this.listedossiers.length) {
      //pas une erreur en fin de parcours
      ArchibaldTrace("getDossierSuivant pas de dossier suivant index_dossier="+this.index_dossier+" - nombre dossiers:"+this.listedossiers.length);
      return null;
    }
    return this.listedossiers[++this.index_dossier];
  },

  //v5 - archivage des messages d'un dossier
  //messages presents dans dossier
  //prise en compte granularite sauf en cas de suppression
  //dossier: dossier source (nsIMsgFolder)
  //listemsg: tableau de messages (nsIMsgHdr)
  archiveDossierMessages: function(dossier, listemsg) {

    ArchibaldTrace("archiveDossierMessages dossier:"+dossier.URI);

    this.dossier_encours=dossier;
    this.listemsg_encours=listemsg;

    this.archiveDossierMessages2();
  },
  //traitements d'archivage de la fonction archiveDossierMessages
  //appelee directement depuis archiveDossierMessages si downloadforoffline à false
  //sinon appelle en fin de telechargement
  archiveDossierMessages2: function() {

    const nb=this.listemsg_encours.length;
    this.nbmsg=nb;
    this.nbarch=0;
    this.nbsup=0;
    this.totalmsg+=nb;
    this.lastkey=-1;

    ArchibaldTrace("archiveDossierMessages2 "+nb+" message(s)");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage des messages du dossier", this.dossier_encours.name+" - "+nb+" message(s)");

    //classement des messages selon granularite (selon config.archiveGranularity)
    this.msg_groups=new Array();
    this.msg_groups["dossier"]=this.dossier_encours;
    if (0==this.config.archiveGranularity) {
      this.msg_groups["groupes"]=new Array();
      this.msg_groups["groupes"].push(this.listemsg_encours);
    } else {
      this.msg_groups["groupes"]=this.triMessagesAnneeMois(this.listemsg_encours);
    }

    //Archiver les groupes de messages
    this.archiveGroupeMsg();
  },

  //archivage du groupe de message
  //de this.msg_groups
  archiveGroupeMsg: function() {

    if (null!=this.msg_groups["encours"]) {
      let  encours=this.msg_groups["encours"];
      delete this.msg_groups["groupes"][encours];
    }

    for (var  aaaamm in this.msg_groups["groupes"]) {

      let  tab=aaaamm.split("-");
      let  annee=tab[0];
      if (0==annee)
        annee=null;
      let  mois=null;
      if (2==tab.length)
        mois=tab[1];
      if (null==mois)
        ArchibaldTrace("archiveGroupeMsg annee:"+annee);
      else
        ArchibaldTrace("archiveGroupeMsg annee:"+annee+" - mois:"+mois);
      let  msgs=this.msg_groups["groupes"][aaaamm];

      let  dossier=this.msg_groups["dossier"];

      this.msg_groups["encours"]=aaaamm;

      this.archiveListeMessages(dossier, msgs, annee, mois);

      return;
    }

    //termine
    this.msg_groups=null;

    //fin traitement dossier
    this.OnDossierEnd();
  },

  //v5 - archivage des messages classes par dossier
  //correspond a l'execution de la fonction principale ArchivageMessages
  archiveMessagesDos: function() {

    if (null!=this.uricourant) {
      delete this.msgs_dos[this.uricourant];
      this.uricourant=null;
    }

    for (var  uri in this.msgs_dos) {
      ArchibaldTrace("archiveMessagesDos traitement dossier uri:"+uri);
      let  msgs=this.msgs_dos[uri];
      let  dossier=msgs[0].folder;
      this.uricourant=uri;

      this.archiveDossierMessages(dossier, msgs);
      return;
    }

    ArchibaldTrace("archiveMessagesDos fin des operations");

    this.msgs_dos=null;

    this.OnArchivageEnd();
  },

  //suppression des messages d'un dossier (ARCH_OPTION_SUPPRIMER)
  supprimeListeMessages: function(dossier, listemsg) {
    ArchibaldTrace("supprimeListeMessages");
    let  msgs=Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);

    const nb=listemsg.length;
    for (var  m=0;m<nb;m++) {
      msgs.appendElement(listemsg[m], false);
    }

    ArchibaldTrace("supprimeListeMessages suppression des messages.");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Suppression des messages", "");

    this.OnSupMsg(nb);

    dossier.deleteMessages(msgs, null, true, false, this, false);

    this.nbsup=nb;
    this.totalsup+=nb;

    this.OnDossierEnd();
  },

  //archivage d'une liste de message classee
  //gere la granularite
  //dossier: dossier source (nsIMsgFolder)
  //listemsg: tableau de messages (nsIMsgHdr)
  //annee: optionnel (usage selon granularite)
  //mois: optionnel (usage selon granularite)
  archiveListeMessages: function (dossier, listemsg, annee, mois) {

    const nb=listemsg.length;
    ArchibaldTrace("archiveListeMessages "+nb+" message(s) dans le dossier:"+dossier.URI);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Traitement des messages du dossier", dossier.name+" - "+nb+" message(s)");

    let  msgs=Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);

    for (var  m=0;m<nb;m++) {
      msgs.appendElement(listemsg[m], false);
    }

    if (this.msg_markread) {
      ArchibaldTrace("archiveListeMessages marquage a lu des messages");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Marquage a lu des messages", "");
      dossier.markMessagesRead(msgs, true);
    }

    if (this.config.modecopie){
      ArchibaldTrace("archiveListeMessages copie des messages.");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Copie des messages", "");
    }
    else{
      ArchibaldTrace("archiveListeMessages archivage des messages.");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Archivage des messages", "");
    }

    this.dossierdest_courant=this.GetDossierArchive(dossier, annee, mois);
    this.nbarch=0;
    this.dossierdest_nbinit=0;
    this.dossierdest_nbinit=this.dossierdest_courant.getTotalMessages(false);
    ArchibaldTrace("archiveListeMessages dossierdest_nbinit:"+this.dossierdest_nbinit);

    this.OnArchiveMsg(nb);

    this.msgCopyService.CopyMessages(dossier, msgs, this.dossierdest_courant, !this.config.modecopie, this, null, false);
  },

  //fonction de classement des messages par annee et/ou annee/mois
  //les messages ont le meme dossier source
  //listemsg: tableau nsIMsgHdr
  //cree un tableau avec indices annee ou annee-mois selon valeur de granularite
  //structure du tableau:
  //["aaaa-mm"]=>messages
  //usage si archiveGranularity 1 ou 2
  triMessagesAnneeMois: function(listemsg) {

    let  msgsam=new Array();
    const nb=listemsg.length;

    for (var  m=0;m<nb;m++) {
      let  hdr=listemsg[m];
      let  dt=new Date(hdr.date/1000);
      let  aa=dt.getFullYear().toString();
      let  mm=dt.getMonth()+1;//getMonth -> 0->11
      let  index=aa;
      if (2==this.config.archiveGranularity) {
        index+="-"+mm;
      }
      if (null==msgsam[index]) {
        ArchibaldTrace("triMessagesAnneeMois tableau index:"+index);
        msgsam[index]=new Array();
      }
      msgsam[index].push(hdr);
    }
    return msgsam;
  },


  //fonction de classement des messages par dossier source
  //listemsg: tableau nsIMsgHdr
  //structure du tableau:
  //tab[URI]=messages du dossier
  triMsgsDossiers: function(listemsg) {

    let  msgs=new Array();

    const nb=listemsg.length;
    for (var  m=0;m<nb;m++) {
      let  hdr=listemsg[m];
      let  uri=hdr.folder.URI;
      if (null==msgs[uri]) {
        ArchibaldTrace("triMsgsDossiers ajout URI:"+uri);
        msgs[uri]=new Array();
      }
      msgs[uri].push(hdr);
    }

    return msgs;
  },

  //marquage des messages archives comme lus
  msgsMoveCopyCompleted: function(aMove, aSrcMsgs, aDestFolder, aDestMsgs) {
    ArchibaldTrace("msgsMoveCopyCompleted aDestFolder:"+aDestFolder.URI);
    if (this.dossierdest_courant.URI==aDestFolder.URI) {

      let  msgs=Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
      const nb=aDestMsgs.length;
      for (var  m=0;m<nb;m++) {
        let  hdr=aDestMsgs.queryElementAt(m, Components.interfaces.nsIMsgDBHdr);
        if (!(hdr.flags & Components.interfaces.nsMsgMessageFlags.Read))
          msgs.appendElement(hdr, false);
      }
      if (0!=msgs.length) {
        ArchibaldTrace("msgsMoveCopyCompleted marquage a lu des messages archives");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Marquage a lu des messages archives", "");
        aDestFolder.markMessagesRead(msgs, true);
      }
      else {
        ArchibaldTrace("msgsMoveCopyCompleted messages archives deja marques a lu");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Messages archives deja marques a lu", "");
      }

    } else {
      ArchibaldTrace("msgsMoveCopyCompleted dossierdest_courant.URI==aDestFolder.URI");
    }
  },

  //determine le dossier d'archivage du compte correspondant au dossier source (meme arborescence)
  //dossiersrc: instance dossier source
  //annee: optionnel (usage selon granularite)
  //mois: optionnel (usage selon granularite)
  //this.config.archiveKeepFolderStructure : si false, pas de structure dossier
  GetDossierArchive: function(dossiersrc, annee, mois) {

    ArchibaldTrace("GetDossierArchive dossiersrc:"+dossiersrc.URI);

    //dosdest: dossier de destination
    let  dosdest=this.dossierdest_racine;

    //v5 -granularite
    if (annee) {
      if (!dosdest.containsChildNamed(annee)) {
        //creer dossier destination
        ArchibaldTrace("GetDossierArchive creation dossier destination annee:"+annee);
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Creation du dossier d'archive", annee);
        dosdest.createSubfolder(annee, null);
      }
      dosdest=dosdest.getChildNamed(annee);

      if (mois) {
        if (!dosdest.containsChildNamed(mois)) {
          //creer dossier destination
          ArchibaldTrace("GetDossierArchive creation dossier destination mois:"+mois);
          ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Creation du dossier d'archive", mois);
          dosdest.createSubfolder(mois, null);
        }
        dosdest=dosdest.getChildNamed(mois);
      }
    }

    if (!this.config.archiveKeepFolderStructure) {
      ArchibaldTrace("Dossier d'archive - structure non reproduite");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Dossier d'archive - structure non reproduite");
      return dosdest;
    }

    //position depart parcours uri
    let  i=3;

    //cas boite partagee
    if (this.config.isBalp()) {

      i=5;

      if (dossiersrc.URI==this.dossiersrc_racine.URI){

        //cas courrier entrant boite partagee
        ArchibaldTrace("GetDossierArchive cas courrier entrant boite partagee");

        let  libentrant=ArchibaldMessageFromId("archibaldLibINBOX");

        if (!dosdest.containsChildNamed(libentrant)) {
          ArchibaldTrace("GetDossierArchive creation courrier entrant boite partagee");

          ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Creation du dossier courrier entrant dans l'archive", "");
          dosdest.createSubfolder(libentrant, null);
        }

        let  dossierdest=dosdest.getChildNamed(libentrant);

        if (!dossierdest.getFlag(FLAGS_DOSSIERS.Inbox)){
          ArchibaldTrace("GetDossierArchive ajout flag Inbox");
          dossierdest.setFlag(FLAGS_DOSSIERS.Inbox);
        }

        ArchibaldTrace("GetDossierArchive courrier entrant boite partagee:"+dossierdest.URI);

        return dossierdest;
      }
    }

    let  elems=dossiersrc.URI.split("/");
    const nb=elems.length;
    let  urisrc=this.dossiersrc_racine.URI;
    ArchibaldTrace("GetDossierArchive dossiersrc_racine.URI:"+urisrc);

    for (;i<nb;i++){

      urisrc+="/"+elems[i];
      ArchibaldTrace("GetDossierArchive urisrc:"+urisrc);
      let  dossrc=MailUtils.getFolderForURI(urisrc, 0);

      let  lib=dossrc.name;
      if (this.win32) {
        //sous win32 supprimer les points terminaux
        lib=lib.replace(/\.*$/,"");
      }
      ArchibaldTrace("GetDossierArchive libelle:"+lib);

      if (!dosdest.containsChildNamed(lib)) {
        //creer dossier destination
        ArchibaldTrace("GetDossierArchive creation dossier destination:"+lib);
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Creation du dossier d'archive", lib);
        dosdest.createSubfolder(lib, null);
      }

      dosdest=dosdest.getChildNamed(lib);
      ArchibaldTrace("GetDossierArchive dossier destination:"+dosdest.URI);

      //flags
      for (var  d=0;d<ARCH_DOSSIERS_SPECIAUX.length;d++){
        let  flag=ARCH_DOSSIERS_SPECIAUX[d];
        if (dossrc.getFlag(flag)){
          ArchibaldTrace("GetDossierArchive ajout flag:"+flag);
          dosdest.setFlag(flag);
        }
      }
    }

    return dosdest;
  },

  /* decouverte des dossiers imap (pas en pop) */
  //decouverte de tous les sous-dossiers de dossier
  //dossier : dossier serveur ou message
  //si non imap, ne lance pas la decouverte => EndDiscoverFolders
  discoverAllFolders: function(dossier) {
    
    ArchibaldTrace("discoverAllFolders dossier:"+dossier.URI);
    if (!(dossier instanceof nsIMsgImapMailFolder)) {
      ArchibaldTrace("discoverAllFolders pas un dossier imap");
      this.EndDiscoverFolders(0);
      return;
    }

    this.foldersDiscoverer=new ArchiDiscoverFolders(this);

    ArchibaldTrace("discoverAllFolders execution decouverte des dossiers imap");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Execution decouverte des dossiers imap");
    this.foldersDiscoverer.DiscoverAllSubFolders(dossier);
  },
  //notification demarrage decouverte
  StartDiscoverFolders: function() {
    
    ArchibaldTrace("StartDiscoverFolders");
    if (null!=this.ecouteur &&
        this.ecouteur.StartDiscoverFolders)
      this.ecouteur.StartDiscoverFolders();
  },
  //notification fin decouverte
  EndDiscoverFolders: function(resultat) {

    ArchibaldTrace("EndDiscoverFolders");
    if (0==resultat)
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Fin de la decouverte des dossiers imap", "OK");
    else
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Fin de la decouverte des dossiers imap", "Code:"+resultat+" - Erreur:"+this.foldersDiscoverer.msgErreur);

    if (null!=this.ecouteur &&
        this.ecouteur.EndDiscoverFolders)
      this.ecouteur.EndDiscoverFolders();

    //operation suivante
    if (ARCH_TYPE_COMPTE==this.typearchivage) {

      this.execArchivageCompte();

    } else {

      //ARCH_TYPE_DOSSIER==this.typearchivage
      if (this.downloadforoffline) {
        //construire liste des sous-dossiers
        this.setupListeDossiers(this.listedossiers[0]);
        //telechargement des dossiers
        this.telechargeDossiers();

      } else {
        //archivage
        this.archiveDossierCourant();
      }
    }
  },
  /* fin decouverte des dossiers */

  /* Telechargement offline des dossiers */
  //traite this.listedossiers : tableau de dossiers nsIMsgFolder
  //uniquement si option archiver
  telechargeDossiers: function() {

    ArchibaldTrace("TelechargeDossiers");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des dossiers");

    if (0==this.listedossiers.length) {
      ArchibaldTrace("TelechargeDossiers - Aucun dossier a telecharger");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun dossier a telecharger");
      //archivage dossier
      this.OnSynchroEnd();
      return;
    }

    let  dossiers=[];
    for (var  dossier of this.listedossiers) {

      ArchibaldTrace("TelechargeDossiers dossier.URI:"+dossier.URI);
      let  option=this.optionsdossiers.LitOptionDossierVal(dossier.URI);

      if (ARCH_OPTION_ARCHIVER==option) {
         ArchibaldTrace("TelechargeDossiers ajout dossier");
        dossiers.push(dossier);
      }
    }

    if (0==dossiers.length) {

      ArchibaldTrace("TelechargeDossiers - Aucun dossier a telecharger");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Aucun dossier a telecharger");
      //archivage dossier
      this.OnSynchroEnd();

      return;
    }

    this.syncrodossiers=new ArchibaldSync(this);
    this.syncrodossiers.SynchroniseDossiers(dossiers);
  },

  //telechargement des messsages d'un dossier
  telechargeMessages: function(dossier, listemsg) {
    ArchibaldTrace("Telechargement des messages du dossier:"+dossier.name);
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Telechargement des messages du dossier:", dossier.name);

    this.syncrodossiers=new ArchibaldSync(this);
    this.syncrodossiers.SynchroniseDossierMsg(dossier, listemsg);
  },

  OnSynchroStart: function() {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroStart)
      this.ecouteur.OnSynchroStart();
  },
  
  //fin de la synchronisation
  OnSynchroEnd: function() {
    if (null!=this.ecouteur &&
        this.ecouteur.OnSynchroEnd)
      this.ecouteur.OnSynchroEnd();

    if (ARCH_TYPE_COMPTE==this.typearchivage ||
        ARCH_TYPE_DOSSIER==this.typearchivage) {
      ArchibaldTrace("OnSynchroEnd appel archiveDossierCourant");
      this.archiveDossierCourant();

    } else if (ARCH_TYPE_MSG==this.typearchivage) {
      ArchibaldTrace("OnSynchroEnd appel archiveDossierMessages2");
      this.archiveDossierMessages2();
    }
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
  SynchroError: function(message) {
    if (null!=this.ecouteur &&
        this.ecouteur.SynchroError)
      this.ecouteur.SynchroError(message);
  },
  /* Fin telechargement offline */

  //terminaison des operations
  finArchivage: function() {

    ArchibaldTrace("finArchivage");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Fin de l'archivage", "");

    this.encours=false;

    if (uidIsBalp(this.config.uid))
      this.libereVerrouArchivage();
  },

  //dossier racine du compte -> force connexion si necessaire
  getDossierRacineCompte: function(){

    let  srv=MailServices.accounts.getIncomingServer(this.config.serverkey);
    
    let  racine=srv.rootMsgFolder;
    
    if (!this.config.isBalp()) {
      ArchibaldTrace("getDossierRacineCompte uri:"+racine.URI);
      return racine;
    }
      
    //cas boite partagee
    let  uri=racine.URI;

    let  compos=this.config.uid.split(".-.");
    uri+="/Boite partag&AOk-e/"+compos[1];

    ArchibaldTrace("getDossierRacineCompte cas boite partagee uri:"+uri);

    let  dos=MailUtils.getFolderForURI(uri, 0);

    return dos;
  },

  //dossier racine d'archivage
  //dossier racine de la configuration courante
  getDossierRacineArchive: function(){

    try{
      let  serveur=ArchiGetSrvDossier(this.config.dossier);
      if (null==serveur)
        return null;
      return serveur.rootMsgFolder;
    }
    catch(ex){
      ArchibaldTrace("Exception getDossierRacineArchive:"+ex);
      return null;
    }
  },

  _accman: null,

  get accman() {

    if (null==this._accman) {

      this._accman=Components.classes["@mozilla.org/messenger/account-manager;1"].
                    getService(Components.interfaces.nsIMsgAccountManager);
    }

    return this._accman;
  },

  _msgCopyService: null,

  get msgCopyService() {

    if (null==this._msgCopyService) {

      this._msgCopyService=Components.classes["@mozilla.org/messenger/messagecopyservice;1"]
                            .getService(Components.interfaces.nsIMsgCopyService);
    }

    return this._msgCopyService;
  },

  initVariables: function() {

    this.typearchivage=ARCH_TYPE_NONE;
    this.msgerreur="";
    this.listedossiers=null;
    this.index_dossier=0;
    this.dossiersrc_racine=null;
    this.dossierdest_racine=null;
    this.verrou=null;
    this.dossierdest_courant=null;
    this.arretarchivage=false;
    this.encours=false;
    this.msg_groups=null;
    this.msgs_dos=null;
    this.uricourant=null;
    this.dossier_encours=null;
    this.listemsg_encours=null;
    this.foldersDiscoverer=null;
    this.bSousDossiers=false;
  },

  initStats: function() {

    this.nbdossiers=0;
    this.nbmsg=0;
    this.nbarch=0;
    this.totalmsg=0;
    this.totalarch=0;
    this.nbsup=0;
    this.totalsup=0;

    this.lastkey=-1;
  },

  /* fonctions de verrouillage */
  verrouArchivage: function() {

    ArchibaldTrace("verrouArchivage");
    if (null==this.verrou) {
      this.verrou=new archibaldLock(this.config);
    }

    return this.verrou.verrouArchivage();
  },
  
  libereVerrouArchivage: function() {

    ArchibaldTrace("libereVerrouArchivage");
    if (null==this.verrou) {
      ArchibaldTrace("Appel libereVerrouArchivage sans verrou");
      return false;
    }

    return this.verrou.libereVerrouArchivage();
  },
  
  majVerrouArchivage: function() {

    ArchibaldTrace("majVerrouArchivage");
    if (null==this.verrou) {
      ArchibaldTrace("Appel majVerrouArchivage sans verrou");
      return false;
    }

    return this.verrou.majVerrouArchivage();
  },

  //calcul de la date d'archivage pour test de date des messages
  //=> initialise this.datehdr
  //return true si ok, false en cas d'erreur
  caculDateArchivage: function() {

    let  jour=new Date();
    let  ms=jour.getTime();
    let  delta=(this.config.jours-1)*86400000;
    ms-=delta;

    jour.setTime(ms);
    jour.setMilliseconds(0);
    jour.setSeconds(0);
    jour.setMinutes(0);
    jour.setHours(0);
    this.datehdr=jour.getTime()*1000;

    return true;
  },

  //nsIMsgCopyServiceListener
  OnStartCopy: function() {
    ArchibaldTrace("ArchibaldArchive OnStartCopy");
    if (null!=this.ecouteur &&
        this.ecouteur.OnStartCopy)
      this.ecouteur.OnStartCopy();
  },
  
  OnProgress: function(aProgress, aProgressMax) {
    if (null!=this.ecouteur &&
        this.ecouteur.OnProgress)
      this.ecouteur.OnProgress(aProgress, aProgressMax);
  },
  
  SetMessageKey: function(aKey) {

    if (this.lastkey!=aKey &&
        this.nbarch<this.nbmsg) {
      this.lastkey=aKey;
      this.nbarch++;
    }

    if (null!=this.ecouteur &&
        this.ecouteur.SetMessageKey)
      this.ecouteur.SetMessageKey(aKey);
  },
  
  GetMessageId: function() {
    if (null!=this.ecouteur &&
        this.ecouteur.GetMessageId)
      this.ecouteur.GetMessageId();
  },
  
  OnStopCopy: function(aStatus) {
    ArchibaldTrace("ArchibaldArchive OnStopCopy");
    if (null!=this.ecouteur &&
        this.ecouteur.OnStopCopy)
      this.ecouteur.OnStopCopy(aStatus);

    if (!Components.isSuccessCode(aStatus)) {
      ArchibaldTrace("ArchibaldArchive OnStopCopy Erreur de copie -> STOP!");
      this.OnErreurArchivage("Erreur d'archivage des messages code:"+aStatus);
      return;
    }

    //mise a jour nombre de messages archives
    let  nbfin=this.dossierdest_courant.getTotalMessages(false);
    ArchibaldTrace("ArchibaldArchive OnStopCopy nbfin:"+nbfin+" - archives="+(nbfin-this.dossierdest_nbinit));
    this.totalarch+=nbfin-this.dossierdest_nbinit;

    //arret force
    if (this.arretarchivage && this.encours) {
      ArchibaldTrace("OnDossierEnd arret force");
      this.OnArretForce();
      return;
    }

    //groupe de message suivant
    this.archiveGroupeMsg();
  },

  //interface nsIUrlListener
  //pour delete mais pas de notifications
  //v5 - telechargement offlin
  OnStartRunningUrl: function(url) {
    ArchibaldTrace("ArchibaldArchive OnStartRunningUrl");
    if (null!=this.ecouteur &&
        this.ecouteur.OnStartRunningUrl)
      this.ecouteur.OnStartRunningUrl(url);
  },
  OnStopRunningUrl: function(url, aExitCode) {
    ArchibaldTrace("ArchibaldArchive OnStopRunningUrl");
    if (null!=this.ecouteur &&
        this.ecouteur.OnStopRunningUrl)
      this.ecouteur.OnStopRunningUrl(url, aExitCode);
  },

  //fonctions notifications des etapes
  OnErreurArchivage: function(errmsg) {

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur d'archivage", errmsg);

    ArchibaldTrace("OnErreurArchivage "+errmsg);
    if (null!=this.ecouteur &&
        this.ecouteur.OnErreurArchivage)
      this.ecouteur.OnErreurArchivage(errmsg);

    this.finArchivage();
  },
  
  OnArchivageStart: function(config) {

    this.encours=true;

    if (null!=this.ecouteur &&
        this.ecouteur.OnArchivageStart)
      this.ecouteur.OnArchivageStart(config);
  },
  
  OnArchivageEnd: function() {

    //traces stats
    ArchibaldTrace("STATS OnArchivageEnd Total msg:"+this.totalmsg+
                    " - archives:"+this.totalarch+" - supprimes:"+this.totalsup);

    if (null!=this.ecouteur &&
        this.ecouteur.OnArchivageEnd)
      this.ecouteur.OnArchivageEnd();

    this.finArchivage();
  },
  
  OnDossierStart: function(dos) {

    if (null!=this.ecouteur &&
        this.ecouteur.OnDossierStart)
      this.ecouteur.OnDossierStart(dos);
  },
  OnDossierEnd: function() {

    this.lastkey=-1;

    if (null!=this.ecouteur &&
        this.ecouteur.OnDossierEnd)
      this.ecouteur.OnDossierEnd();

    //traces stats
    ArchibaldTrace("STATS OnDossierEnd Total msg:"+this.nbmsg+
                    " - archives:"+this.nbarch+" - supprimes:"+this.nbsup);

    //arret force
    if (this.arretarchivage && this.encours) {
      ArchibaldTrace("OnDossierEnd arret force");
      this.OnArretForce();
      return;
    }

    //ARCH_TYPE_MSG
    if (ARCH_TYPE_MSG==this.typearchivage){
      ArchibaldTrace("OnDossierEnd ARCH_TYPE_MSG");
      //archivage messages classes par dossiers
      this.archiveMessagesDos();
      return;
    }

    //ARCH_TYPE_COMPTE
    //dossier suivant
    let  dos=this.getDossierSuivant();
    if (null==dos) {
      //tous les dossiers ont ete traites
      ArchibaldTrace("OnDossierEnd fin d'archivage");
      this.OnArchivageEnd();
      return;
    }

    this.archiveDossierCourant();
  },

  OnArretForce: function() {
    ArchibaldTrace("OnArretForce");
    if (null!=this.ecouteur &&
        this.ecouteur.OnArretForce)
      this.ecouteur.OnArretForce();
    this.OnArchivageEnd();
  },
  
  OnArchiveMsg: function(nb){
    this.lastkey=-1;
    if (null!=this.ecouteur &&
        this.ecouteur.OnArchiveMsg)
      this.ecouteur.OnArchiveMsg(nb);
  },
  
  OnSupMsg: function(nb){
    if (null!=this.ecouteur &&
        this.ecouteur.OnSupMsg)
      this.ecouteur.OnSupMsg(nb);
  }
}
