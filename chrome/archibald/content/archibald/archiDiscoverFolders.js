
ChromeUtils.import("resource:///modules/mailServices.js");

const nsIMsgImapMailFolder=Components.interfaces.nsIMsgImapMailFolder;

function ArchiDiscoverFolders(ecouteur) {

  this.ecouteur=ecouteur;
}

ArchiDiscoverFolders.prototype = {

  //liste des dossiers a traiter
  listeDossiers: null,

  //dossier en cours
  dossier_courant: null,

  //service imap
  imapService: null,

  //message d'erreur
  msgErreur: null,

  /* fonctions principales */

  //tous les sous-dossiers (recursif)
  DiscoverAllSubFolders: function(dossier) {

    ArchibaldTrace("ArchiDiscoverFolders DiscoverAllSubFolders dossier:"+dossier.URI);

    this.initVariables();

    if (!(dossier instanceof nsIMsgImapMailFolder)) {
      ArchibaldTrace("ArchiDiscoverFolders DiscoverAllFolders !nsIMsgImapMailFolder");
      this.msgErreur="Pas un dossier imap";
      this.EndDiscoverFolders(-1);
      return;
    }

    this.listeDossiers.push(dossier);

    //demarrage
    this.StartDiscoverFolders();

    this.discoverDossierSuivant();
  },

  /* notifications ecouteur */
  //debut des operations
  StartDiscoverFolders: function() {

    if (this.ecouteur)
      this.ecouteur.StartDiscoverFolders();
  },
  
  //fin des operations
  EndDiscoverFolders: function(resultat) {
    if (this.ecouteur)
      this.ecouteur.EndDiscoverFolders(resultat);
  },

  /* fonctions internes */
  //extrait le dossier suivant de listeDossiers
  //retourne null si aucun
  dossierSuivant: function() {

    if (0==this.listeDossiers.length) {
      ArchibaldTrace("ArchiDiscoverFolders dossierSuivant => aucun");
      return null;
    }

    let  dossier=this.listeDossiers.shift();
    ArchibaldTrace("ArchiDiscoverFolders dossierSuivant:"+dossier.URI);
    return dossier;
  },

  //traite dossier suivant (discoverAllFolders ou discoverChildren)
  discoverDossierSuivant: function() {

    this.dossier_courant=this.dossierSuivant();
    if (null==this.dossier_courant) {
      ArchibaldTrace("discoverDossierSuivant plus de dossier a traiter");
      this.EndDiscoverFolders(0);
      return;
    }

    if (!(this.dossier_courant instanceof nsIMsgImapMailFolder)) {
      ArchibaldTrace("ArchiDiscoverFolders discoverDossierSuivant !nsIMsgImapMailFolder");
      this.msgErreur="Pas un dossier imap";
      this.EndDiscoverFolders(0);
      return;
    }

    if (this.dossier_courant.isServer) {
      ArchibaldTrace("ArchiDiscoverFolders discoverDossierSuivant isServer => discoverAllFolders");
      let  outUrl=new Object();
      this.imapService.discoverAllFolders(this.dossier_courant, this, null, outUrl);

    } else {
      let  onlineName=this.dossier_courant.getStringProperty("onlineName");
      ArchibaldTrace("ArchiDiscoverFolders discoverDossierSuivant onlineName:"+onlineName);
      let  outUrl=new Object();
      this.imapService.discoverChildren(this.dossier_courant, this, onlineName, outUrl);
    }
  },

  //parcours les sous-dossiers de dossier
  //les ajoute dans this.listeDossiers
  listageSousDossiers: function(dossier) {

    ArchibaldTrace("ArchiDiscoverFolders listageSousDossiers:"+dossier.URI);

    let  subFolders=dossier.subFolders;
    while (subFolders.hasMoreElements()) {
      let  suivant=subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);
      if (null==suivant) {
        ArchibaldTrace("ArchiDiscoverFolders listageSousDossiers null==suivant");
        continue;
      }
      if (suivant instanceof Components.interfaces.nsIMsgImapMailFolder) {
        ArchibaldTrace("ArchiDiscoverFolders listageSousDossiers suivant.URI:"+suivant.URI);
        this.listeDossiers.push(suivant);
      } else {
        ArchibaldTrace("ArchiDiscoverFolders listageSousDossiers pas un dossier imap:"+dossier.URI);
      }
    }
  },

  initVariables: function() {

    ArchibaldTrace("ArchiDiscoverFolders initVariables");

    this.listeDossiers=new Array();
    this.dossier_courant=null;

    this.dossier_courant=null;

    //service imap
    this.imapService=MailServices.imap;

    //message d'erreur
    this.msgErreur="";
  },


  //nsIUrlListener
  //in nsIURI url
  OnStartRunningUrl: function(url) {

    ArchibaldTrace("ArchiDiscoverFolders OnStartRunningUrl:"+url.asciiSpec);
  },
  
  //in nsIURI url, in nsresult aExitCode
  OnStopRunningUrl: function(url, aExitCode) {

    ArchibaldTrace("ArchiDiscoverFolders OnStopRunningUrl url"+url.asciiSpec+" - aExitCode:"+aExitCode);

    if (0!=aExitCode) {
      this.msgErreur="Erreur de traitement du dossier:"+this.dossier_courant.URI;
      this.EndDiscoverFolders(aExitCode);
      return;
    }
    
    //succes discoverAllFolders ou discoverChildren pour dossier_courant
    //lister les sous-dossiers
    this.listageSousDossiers(this.dossier_courant);
    //traiter dossier suivant
    this.discoverDossierSuivant();
  }
}