# Scenario C: Cloud Relay Deployment Guide

If you don't have a local computer to run the payload bridge on-site, you can host the bridge safely in the cloud for free. 

### Why do this?
By hosting this securely on a platform like Render.com, your DTU just needs an internet connection to send HTTP data to your cloud URL. The cloud server will instantly re-package it as perfect JSON and securely forward it over TLS to the LakeLedger servers.

### How to Deploy (Step by Step)

1. **Create an Account:** Go to [Render.com](https://render.com) and create a free account.
2. **Create a GitHub Repo:** Upload this exact folder (`Scenario_C_Cloud_Relay_Kit`) to a remote GitHub repository. Don't forget to push your updated `config.json` containing your custom username and password!
3. **Deploy on Render:**
   - On the Render dashboard, click **"New +" -> "Web Service"**.
   - Connect it to the GitHub repository you just made.
   - Render will automatically detect the `Dockerfile` inside this folder and build it for you.
4. **Get the URL:** Once deployed, Render will give you a public URL (e.g., `https://dtu-bridge.onrender.com`).

### Update your DTU Settings
Now that your bridge is live on the internet, point your DTU to it!
- In the DTU interface, change it to push data via HTTP POST.
- The URL format will be: `https://YOUR-RENDER-URL.onrender.com/data`

It will instantly start flowing data!
