import mongoose from 'mongoose'
import escapeStringRegexp from 'escape-string-regexp'
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { Request, Response } from 'express'
import * as bookcarsTypes from 'bookcars-types'
import i18n from '../lang/i18n'
import Booking from '../models/Booking'
import User from '../models/User'
import Token from '../models/Token'
import Car from '../models/Car'
import Location from '../models/Location'
import Notification from '../models/Notification'
import NotificationCounter from '../models/NotificationCounter'
import PushToken from '../models/PushToken'
import AdditionalDriver from '../models/AdditionalDriver'
import * as helper from '../common/helper'
import * as mailHelper from '../common/mailHelper'
import * as env from '../config/env.config'

/**
 * Create a Booking.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const create = async (req: Request, res: Response) => {
  try {
    const { body }: { body: bookcarsTypes.UpsertBookingPayload } = req
    if (body.booking.additionalDriver) {
      const additionalDriver = new AdditionalDriver(body.additionalDriver)
      await additionalDriver.save()
      body.booking._additionalDriver = additionalDriver._id.toString()
    }

    const booking = new Booking(body.booking)

    await booking.save()
    return res.json(booking)
  } catch (err) {
    console.error(`[booking.create] ${i18n.t('DB_ERROR')} ${req.body}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Notify a supplier.
 *
 * @async
 * @param {env.User} user
 * @param {string} bookingId
 * @param {env.User} company
 * @param {string} notificationMessage
 * @returns {void}
 */
const notifySupplier = async (user: env.User, bookingId: string, company: env.User, notificationMessage: string) => {
  i18n.locale = company.language

  // notification
  const message = `${user.fullName} ${notificationMessage} ${bookingId}.`
  const notification = new Notification({
    user: company._id,
    message,
    booking: bookingId,
  })

  await notification.save()
  let counter = await NotificationCounter.findOne({ user: company._id })
  if (counter && typeof counter.count !== 'undefined') {
    counter.count += 1
    await counter.save()
  } else {
    counter = new NotificationCounter({ user: company._id, count: 1 })
    await counter.save()
  }

  // mail
  const mailOptions = {
    from: env.SMTP_FROM,
    to: company.email,
    subject: message,
    html: `<p>
    ${i18n.t('HELLO')}${company.fullName},<br><br>
    ${message}<br><br>
    ${helper.joinURL(env.BACKEND_HOST, `booking?b=${bookingId}`)}<br><br>
    ${i18n.t('REGARDS')}<br>
    </p>`,
  }

  await mailHelper.sendMail(mailOptions)
}

/**
 * Complete checkout process and create Booking.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const checkout = async (req: Request, res: Response) => {
  try {
    let user: env.User | null
    const { body }: { body: bookcarsTypes.CheckoutPayload } = req
    const { driver } = body

    if (!body.booking) {
      console.log('booking not found', body)
      return res.sendStatus(400)
    }

    if (driver) {
      driver.verified = false
      driver.blacklisted = false
      driver.type = bookcarsTypes.UserType.User

      user = new User(driver)
      await user.save()

      const token = new Token({ user: user._id, token: helper.generateToken() })
      await token.save()

      i18n.locale = user.language

      const mailOptions = {
        from: env.SMTP_FROM,
        to: user.email,
        subject: i18n.t('ACCOUNT_ACTIVATION_SUBJECT'),
        html: `<p>
        ${i18n.t('HELLO')}${user.fullName},<br><br>
        ${i18n.t('ACCOUNT_ACTIVATION_LINK')}<br><br>
        ${helper.joinURL(env.FRONTEND_HOST, 'activate')}/?u=${encodeURIComponent(user._id.toString())}&e=${encodeURIComponent(user.email)}&t=${encodeURIComponent(token.token)}<br><br>
        ${i18n.t('REGARDS')}<br>
        </p>`,
      }
      await mailHelper.sendMail(mailOptions)

      body.booking.driver = user._id.toString()
    } else {
      user = await User.findById(body.booking.driver)
    }

    if (!user) {
      console.log('Driver not found', body)
      return res.sendStatus(204)
    }

    const { language } = user
    i18n.locale = language

    // additionalDriver
    if (body.booking.additionalDriver && body.additionalDriver) {
      const additionalDriver = new AdditionalDriver(body.additionalDriver)
      await additionalDriver.save()
      body.booking._additionalDriver = additionalDriver._id.toString()
    }

    const booking = new Booking(body.booking)

    await booking.save()

    const locale = language === 'fr' ? 'fr-FR' : 'en-US'
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      month: 'long',
      year: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }
    const from = booking.from.toLocaleString(locale, options)
    const to = booking.to.toLocaleString(locale, options)
    const car = await Car.findById(booking.car).populate<{ company: env.User }>('company')
    if (!car) {
      console.log(`Car ${booking.car} not found`)
      return res.sendStatus(204)
    }
    const pickupLocation = await Location.findById(booking.pickupLocation).populate<{ values: env.LocationValue[] }>('values')
    if (!pickupLocation) {
      console.log(`Pickup location ${booking.pickupLocation} not found`)
      return res.sendStatus(204)
    }

    const pickupLocationName = pickupLocation.values.filter((value) => value.language === language)[0].value
    const dropOffLocation = await Location.findById(booking.dropOffLocation).populate<{ values: env.LocationValue[] }>('values')
    if (!dropOffLocation) {
      console.log(`Drop-off location ${booking.pickupLocation} not found`)
      return res.sendStatus(204)
    }
    const dropOffLocationName = dropOffLocation.values.filter((value) => value.language === language)[0].value

    const mailOptions = {
      from: env.SMTP_FROM,
      to: user.email,
      subject: `${i18n.t('BOOKING_CONFIRMED_SUBJECT_PART1')} ${booking._id} ${i18n.t('BOOKING_CONFIRMED_SUBJECT_PART2')}`,
      html:
        `<p>
        ${i18n.t('HELLO')}${user.fullName},<br><br>
        ${!body.payLater ? `${i18n.t('BOOKING_CONFIRMED_PART1')} ${booking._id} ${i18n.t('BOOKING_CONFIRMED_PART2')}`
          + '<br><br>' : ''}
        ${i18n.t('BOOKING_CONFIRMED_PART3')}${car.company.fullName}${i18n.t('BOOKING_CONFIRMED_PART4')}${pickupLocationName}${i18n.t('BOOKING_CONFIRMED_PART5')}`
        + `${from} ${i18n.t('BOOKING_CONFIRMED_PART6')}`
        + `${car.name}${i18n.t('BOOKING_CONFIRMED_PART7')}`
        + `<br><br>${i18n.t('BOOKING_CONFIRMED_PART8')}<br><br>`
        + `${i18n.t('BOOKING_CONFIRMED_PART9')}${car.company.fullName}${i18n.t('BOOKING_CONFIRMED_PART10')}${dropOffLocationName}${i18n.t('BOOKING_CONFIRMED_PART11')}`
        + `${to} ${i18n.t('BOOKING_CONFIRMED_PART12')}`
        + `<br><br>${i18n.t('BOOKING_CONFIRMED_PART13')}<br><br>${i18n.t('BOOKING_CONFIRMED_PART14')}${env.FRONTEND_HOST}<br><br>
        ${i18n.t('REGARDS')}<br>
        </p>`,
    }
    await mailHelper.sendMail(mailOptions)

    // Notify supplier
    const supplier = await User.findById(booking.company)
    if (!supplier) {
      console.log(`Supplier ${booking.company} not found`)
      return res.sendStatus(204)
    }
    i18n.locale = supplier.language
    await notifySupplier(user, booking._id.toString(), supplier, i18n.t('BOOKING_NOTIFICATION'))

    return res.sendStatus(200)
  } catch (err) {
    console.error(`[booking.book]  ${i18n.t('ERROR')}`, err)
    return res.status(400).send(i18n.t('ERROR') + err)
  }
}

/**
 * Notify driver and send push notification.
 *
 * @async
 * @param {env.Booking} booking
 * @returns {void}
 */
const notifyDriver = async (booking: env.Booking) => {
  const driver = await User.findById(booking.driver)
  if (!driver) {
    console.log(`Renter ${booking.driver} not found`)
    return
  }

  i18n.locale = driver.language

  const message = `${i18n.t('BOOKING_UPDATED_NOTIFICATION_PART1')} ${booking._id} ${i18n.t('BOOKING_UPDATED_NOTIFICATION_PART2')}`
  const notification = new Notification({
    user: driver._id,
    message,
    booking: booking._id,
  })
  await notification.save()

  let counter = await NotificationCounter.findOne({ user: driver._id })
  if (counter && typeof counter.count !== 'undefined') {
    counter.count += 1
    await counter.save()
  } else {
    counter = new NotificationCounter({ user: driver._id, count: 1 })
    await counter.save()
  }

  // mail
  const mailOptions = {
    from: env.SMTP_FROM,
    to: driver.email,
    subject: message,
    html: `<p>
    ${i18n.t('HELLO')}${driver.fullName},<br><br>
    ${message}<br><br>
    ${helper.joinURL(env.FRONTEND_HOST, `booking?b=${booking._id}`)}<br><br>
    ${i18n.t('REGARDS')}<br>
    </p>`,
  }
  await mailHelper.sendMail(mailOptions)

  // push notification
  const pushToken = await PushToken.findOne({ user: driver._id })
  if (pushToken) {
    const { token } = pushToken
    const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN })

    if (!Expo.isExpoPushToken(token)) {
      console.log(`Push token ${token} is not a valid Expo push token.`)
      return
    }

    const messages: ExpoPushMessage[] = [
      {
        to: token,
        sound: 'default',
        body: message,
        data: {
          user: driver._id,
          notification: notification._id,
          booking: booking._id,
        },
      },
    ]

    // The Expo push notification service accepts batches of notifications so
    // that you don't need to send 1000 requests to send 1000 notifications. We
    // recommend you batch your notifications to reduce the number of requests
    // and to compress them (notifications with similar content will get
    // compressed).
    const chunks = expo.chunkPushNotifications(messages)
    const tickets: ExpoPushTicket[] = [];

    (async () => {
      // Send the chunks to the Expo push notification service. There are
      // different strategies you could use. A simple one is to send one chunk at a
      // time, which nicely spreads the load out over time:
      for (const chunk of chunks) {
        try {
          const ticketChunks = await expo.sendPushNotificationsAsync(chunk)

          tickets.push(...ticketChunks)

          // NOTE: If a ticket contains an error code in ticket.details.error, you
          // must handle it appropriately. The error codes are listed in the Expo
          // documentation:
          // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
          for (const ticketChunk of ticketChunks) {
            if (ticketChunk.status === 'ok') {
              console.log(`Push notification sent: ${ticketChunk.id}`)
            } else {
              throw new Error(ticketChunk.message)
            }
          }
        } catch (error) {
          console.error(error)
        }
      }
    })()
  }
}

/**
 * Update Booking.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const update = async (req: Request, res: Response) => {
  try {
    const { body }: { body: bookcarsTypes.UpsertBookingPayload } = req
    const booking = await Booking.findById(body.booking._id)

    if (booking) {
      if (!body.booking.additionalDriver && booking._additionalDriver) {
        await AdditionalDriver.deleteOne({ _id: booking._additionalDriver })
      }

      if (body.additionalDriver) {
        const {
          fullName,
          email,
          phone,
          birthDate,
        } = body.additionalDriver

        if (booking._additionalDriver) {
          const additionalDriver = await AdditionalDriver.findOne({ _id: booking._additionalDriver })
          if (!additionalDriver) {
            const msg = `Additional Driver ${booking._additionalDriver} not found`
            console.log(msg)
            return res.status(204).send(msg)
          }
          additionalDriver.fullName = fullName
          additionalDriver.email = email
          additionalDriver.phone = phone
          additionalDriver.birthDate = birthDate
          await additionalDriver.save()
        } else {
          const additionalDriver = new AdditionalDriver({
            fullName,
            email,
            phone,
            birthDate,
          })

          await additionalDriver.save()
          booking._additionalDriver = additionalDriver._id
        }
      }

      const {
        company,
        car,
        driver,
        pickupLocation,
        dropOffLocation,
        from,
        to,
        status,
        cancellation,
        amendments,
        theftProtection,
        collisionDamageWaiver,
        fullInsurance,
        additionalDriver,
        price,
      } = body.booking

      const previousStatus = booking.status

      booking.company = new mongoose.Types.ObjectId(company as string)
      booking.car = new mongoose.Types.ObjectId(car as string)
      booking.driver = new mongoose.Types.ObjectId(driver as string)
      booking.pickupLocation = new mongoose.Types.ObjectId(pickupLocation as string)
      booking.dropOffLocation = new mongoose.Types.ObjectId(dropOffLocation as string)
      booking.from = from
      booking.to = to
      booking.status = status
      booking.cancellation = cancellation
      booking.amendments = amendments
      booking.theftProtection = theftProtection
      booking.collisionDamageWaiver = collisionDamageWaiver
      booking.fullInsurance = fullInsurance
      booking.additionalDriver = additionalDriver
      booking.price = price as number

      if (!additionalDriver && booking._additionalDriver) {
        booking._additionalDriver = undefined
      }

      await booking.save()

      if (previousStatus !== status) {
        // notify driver
        await notifyDriver(booking)
      }

      return res.json(booking)
    }

    console.error('[booking.update] Booking not found:', body.booking._id)
    return res.sendStatus(204)
  } catch (err) {
    console.error(`[booking.update]  ${i18n.t('DB_ERROR')} ${req.body}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Update Booking Status.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const updateStatus = async (req: Request, res: Response) => {
  try {
    const { body }: { body: bookcarsTypes.UpdateStatusPayload } = req
    const { ids: _ids, status } = body
    const ids = _ids.map((id) => new mongoose.Types.ObjectId(id))
    const bulk = Booking.collection.initializeOrderedBulkOp()
    const bookings = await Booking.find({ _id: { $in: ids } })

    bulk.find({ _id: { $in: ids } }).update({ $set: { status } })
    await bulk.execute()
    bookings.forEach(async (booking) => {
      if (booking.status !== status) {
        await notifyDriver(booking)
      }
    })

    return res.sendStatus(200)
  } catch (err) {
    console.error(`[booking.updateStatus]  ${i18n.t('DB_ERROR')} ${req.body}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Delete Bookings.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const deleteBookings = async (req: Request, res: Response) => {
  try {
    const { body }: { body: string[] } = req
    const ids = body.map((id) => new mongoose.Types.ObjectId(id))
    const bookings = await Booking.find({
      _id: { $in: ids },
      additionalDriver: true,
      _additionalDriver: { $ne: null },
    })

    await Booking.deleteMany({ _id: { $in: ids } })
    const additionalDivers = bookings.map((booking) => new mongoose.Types.ObjectId(booking._additionalDriver))
    await AdditionalDriver.deleteMany({ _id: { $in: additionalDivers } })

    return res.sendStatus(200)
  } catch (err) {
    console.error(`[booking.deleteBookings]  ${i18n.t('DB_ERROR')} ${req.body}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Get Booking by ID.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const getBooking = async (req: Request, res: Response) => {
  const { id } = req.params

  try {
    const booking = await Booking.findById(id)
      .populate<{ company: env.UserInfo }>('company')
      .populate<{ car: env.CarInfo }>({
        path: 'car',
        populate: {
          path: 'company',
          model: 'User',
        },
      })
      .populate<{ driver: env.User }>('driver')
      .populate<{ pickupLocation: env.LocationInfo }>({
        path: 'pickupLocation',
        populate: {
          path: 'values',
          model: 'LocationValue',
        },
      })
      .populate<{ dropOffLocation: env.LocationInfo }>({
        path: 'dropOffLocation',
        populate: {
          path: 'values',
          model: 'LocationValue',
        },
      })
      .populate<{ _additionalDriver: env.AdditionalDriver }>('_additionalDriver')
      .lean()

    if (booking) {
      const { language } = req.params

      booking.company = {
        _id: booking.company._id,
        fullName: booking.company.fullName,
        avatar: booking.company.avatar,
        payLater: booking.company.payLater,
      }

      booking.car.company = {
        _id: booking.car.company._id,
        fullName: booking.car.company.fullName,
        avatar: booking.car.company.avatar,
        payLater: booking.car.company.payLater,
      }

      booking.pickupLocation.name = booking.pickupLocation.values.filter((value) => value.language === language)[0].value
      booking.dropOffLocation.name = booking.dropOffLocation.values.filter((value) => value.language === language)[0].value

      return res.json(booking)
    }

    console.error('[booking.getBooking] Booking not found:', id)
    return res.sendStatus(204)
  } catch (err) {
    console.error(`[booking.getBooking]  ${i18n.t('DB_ERROR')} ${id}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Get Bookings.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const getBookings = async (req: Request, res: Response) => {
  try {
    const { body }: { body: bookcarsTypes.GetBookingsPayload } = req
    const page = Number.parseInt(req.params.page, 10)
    const size = Number.parseInt(req.params.size, 10)
    const companies = body.companies.map((id) => new mongoose.Types.ObjectId(id))
    const {
      statuses,
      user,
      car,
    } = body
    const from = (body.filter && body.filter.from && new Date(body.filter.from)) || null
    const to = (body.filter && body.filter.to && new Date(body.filter.to)) || null
    const pickupLocation = (body.filter && body.filter.pickupLocation) || null
    const dropOffLocation = (body.filter && body.filter.dropOffLocation) || null
    let keyword = (body.filter && body.filter.keyword) || ''
    const options = 'i'

    const $match: mongoose.FilterQuery<any> = {
      $and: [{ 'company._id': { $in: companies } }, { status: { $in: statuses } }],
    }

    if (user) {
      $match.$and!.push({ 'driver._id': { $eq: new mongoose.Types.ObjectId(user) } })
    }
    if (car) {
      $match.$and!.push({ 'car._id': { $eq: new mongoose.Types.ObjectId(car) } })
    }
    if (from) {
      $match.$and!.push({ from: { $gte: from } })
    } // $from > from
    if (to) {
      $match.$and!.push({ to: { $lte: to } })
    } // $to < to
    if (pickupLocation) {
      $match.$and!.push({ 'pickupLocation._id': { $eq: new mongoose.Types.ObjectId(pickupLocation) } })
    }
    if (dropOffLocation) {
      $match.$and!.push({ 'dropOffLocation._id': { $eq: new mongoose.Types.ObjectId(dropOffLocation) } })
    }
    if (keyword) {
      const isObjectId = helper.isValidObjectId(keyword)
      if (isObjectId) {
        $match.$and!.push({
          _id: { $eq: new mongoose.Types.ObjectId(keyword) },
        })
      } else {
        keyword = escapeStringRegexp(keyword)
        $match.$and!.push({
          $or: [
            { 'company.fullName': { $regex: keyword, $options: options } },
            { 'driver.fullName': { $regex: keyword, $options: options } },
            { 'car.name': { $regex: keyword, $options: options } },
          ],
        })
      }
    }

    const { language } = req.params

    const data = await Booking.aggregate([
      {
        $lookup: {
          from: 'User',
          let: { companyId: '$company' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$companyId'] } },
            },
          ],
          as: 'company',
        },
      },
      { $unwind: { path: '$company', preserveNullAndEmptyArrays: false } },
      {
        $lookup: {
          from: 'Car',
          let: { carId: '$car' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$carId'] } },
            },
          ],
          as: 'car',
        },
      },
      { $unwind: { path: '$car', preserveNullAndEmptyArrays: false } },
      {
        $lookup: {
          from: 'User',
          let: { driverId: '$driver' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$driverId'] } },
            },
          ],
          as: 'driver',
        },
      },
      { $unwind: { path: '$driver', preserveNullAndEmptyArrays: false } },
      {
        $lookup: {
          from: 'Location',
          let: { pickupLocationId: '$pickupLocation' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$pickupLocationId'] } },
            },
            {
              $lookup: {
                from: 'LocationValue',
                let: { values: '$values' },
                pipeline: [
                  {
                    $match: {
                      $and: [{ $expr: { $in: ['$_id', '$$values'] } }, { $expr: { $eq: ['$language', language] } }],
                    },
                  },
                ],
                as: 'value',
              },
            },
            {
              $addFields: { name: '$value.value' },
            },
          ],
          as: 'pickupLocation',
        },
      },
      {
        $unwind: { path: '$pickupLocation', preserveNullAndEmptyArrays: false },
      },
      {
        $lookup: {
          from: 'Location',
          let: { dropOffLocationId: '$dropOffLocation' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$dropOffLocationId'] } },
            },
            {
              $lookup: {
                from: 'LocationValue',
                let: { values: '$values' },
                pipeline: [
                  {
                    $match: {
                      $and: [{ $expr: { $in: ['$_id', '$$values'] } }, { $expr: { $eq: ['$language', language] } }],
                    },
                  },
                ],
                as: 'value',
              },
            },
            {
              $addFields: { name: '$value.value' },
            },
          ],
          as: 'dropOffLocation',
        },
      },
      {
        $unwind: {
          path: '$dropOffLocation',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $match,
      },
      {
        $facet: {
          resultData: [{ $sort: { createdAt: -1 } }, { $skip: (page - 1) * size }, { $limit: size }],
          pageInfo: [
            {
              $count: 'totalRecords',
            },
          ],
        },
      },
    ])

    const bookings: env.BookingInfo[] = data[0].resultData

    for (const booking of bookings) {
      const { _id, fullName, avatar } = booking.company
      booking.company = { _id, fullName, avatar }
    }

    return res.json(data)
  } catch (err) {
    console.error(`[booking.getBookings] ${i18n.t('DB_ERROR')} ${req.body}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Check if a driver has Bookings.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const hasBookings = async (req: Request, res: Response) => {
  const { driver } = req.params

  try {
    const count = await Booking
      .find({
        driver: new mongoose.Types.ObjectId(driver),
      })
      .limit(1)
      .countDocuments()

    if (count === 1) {
      return res.sendStatus(200)
    }

    return res.sendStatus(204)
  } catch (err) {
    console.error(`[booking.hasBookings] ${i18n.t('DB_ERROR')} ${driver}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}

/**
 * Cancel a Booking.
 *
 * @export
 * @async
 * @param {Request} req
 * @param {Response} res
 * @returns {unknown}
 */
export const cancelBooking = async (req: Request, res: Response) => {
  const { id } = req.params

  try {
    const booking = await Booking
      .findOne({
        _id: new mongoose.Types.ObjectId(id),
      })
      .populate<{ company: env.User }>('company')
      .populate<{ driver: env.User }>('driver')

    if (booking && booking.cancellation && !booking.cancelRequest) {
      booking.cancelRequest = true
      await booking.save()

      // Notify supplier
      await notifySupplier(booking.driver, booking._id.toString(), booking.company, i18n.t('CANCEL_BOOKING_NOTIFICATION'))

      return res.sendStatus(200)
    }

    return res.sendStatus(204)
  } catch (err) {
    console.error(`[booking.cancelBooking] ${i18n.t('DB_ERROR')} ${id}`, err)
    return res.status(400).send(i18n.t('DB_ERROR') + err)
  }
}
