window.addEventListener('DOMContentLoaded', () => {

    console.log('script');

    // parameters
    const composeWindowId = window["composeWindowId"];

    // script
    let button = document.createElement('button');
    button.innerHTML = "ajouter mail";
    button.onclick = () => {
        addRecipient(["testString@mail.fr", composeWindowId]);
    };
    document.querySelector(".wy-side-nav-search")[0].appendChild(button);

});
